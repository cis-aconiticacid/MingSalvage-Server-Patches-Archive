const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const steam = require("./steam.cjs");

// 关掉 Chromium 自动播放限制：让主界面背景音乐进游戏即响，无需用户先有手势。
// 命令行开关须在 app ready 前设；与 webPreferences.autoplayPolicy 双保险（不同版本认其一）。
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const repoRoot = path.resolve(__dirname, "..", "..");
const host = "127.0.0.1";
const isPackaged = app.isPackaged;

let backend = null;
let mainWindow = null;

const log = (...args) => console.log("[electron]", ...args);
const warn = (...args) => console.warn("[electron]", ...args);

// 窗口偏好（目前只有全屏）持久化到 userData/window-prefs.json，启动时按上次状态恢复。
const windowPrefsPath = () => path.join(app.getPath("userData"), "window-prefs.json");

const readWindowPrefs = () => {
  try {
    const raw = fs.readFileSync(windowPrefsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeWindowPrefs = (patch) => {
  try {
    const next = { ...readWindowPrefs(), ...patch };
    fs.writeFileSync(windowPrefsPath(), JSON.stringify(next), "utf8");
  } catch (e) {
    warn("write window-prefs failed:", e instanceof Error ? e.message : String(e));
  }
};

const readDotEnv = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
};

const findOpenPort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const waitForBackend = (port, timeoutMs = 45000) => {
  const startedAt = Date.now();
  const urlPath = "/api/menu/status";
  return new Promise((resolve, reject) => {
    const tick = () => {
      const request = http.get({ host, port, path: urlPath, timeout: 1500 }, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.on("timeout", () => {
        request.destroy(new Error("timeout"));
      });
      request.on("error", retry);
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`FastAPI did not become ready on ${host}:${port}`));
        return;
      }
      setTimeout(tick, 300);
    };

    tick();
  });
};

const pythonExecutable = () => {
  const venvPython = path.join(repoRoot, ".venv", os.platform() === "win32" ? "Scripts/python.exe" : "bin/python");
  if (fs.existsSync(venvPython)) return venvPython;
  return os.platform() === "win32" ? "python" : "python3";
};

const backendExecutablePath = () => {
  const baseDir = process.resourcesPath;
  const exeName = os.platform() === "win32" ? "MingSalvageBackend.exe" : "MingSalvageBackend";
  return path.join(baseDir, "backend", "MingSalvageBackend", exeName);
};

const backendSpawnSpec = () => {
  if (isPackaged) {
    const executable = backendExecutablePath();
    if (!fs.existsSync(executable)) {
      throw new Error(`Packaged backend executable not found: ${executable}`);
    }
    return {
      command: executable,
      args: [],
      cwd: path.dirname(executable),
    };
  }
  return {
    command: pythonExecutable(),
    args: ["-m", "uvicorn", "web_app:app"],
    cwd: repoRoot,
  };
};

const startBackend = async () => {
  const port = await findOpenPort();
  const dotenv = isPackaged ? {} : readDotEnv(path.join(repoRoot, ".env"));
  const env = {
    ...process.env,
    ...dotenv,
    // LLM payload dump 是开发调试用（写 scripts/runs/，打包后该相对路径不存在 → 只刷错误日志）。
    // 默认不开；env/.env 仍可强制开（开发）。
    ...(process.env.MING_SIM_DUMP_LLM || dotenv.MING_SIM_DUMP_LLM
      ? { MING_SIM_DUMP_LLM: process.env.MING_SIM_DUMP_LLM || dotenv.MING_SIM_DUMP_LLM }
      : {}),
    // HTTP debug 默认不写死开：由设置页「调试」开关控制（持久化 runtime_llm.json 的 http_debug），
    // 开后把真实 LLM 请求(URL/headers/body)与响应打到 backend.log。env 仍可强制开（开发/CI）。
    ...(process.env.MING_SIM_HTTP_DEBUG || dotenv.MING_SIM_HTTP_DEBUG
      ? { MING_SIM_HTTP_DEBUG: process.env.MING_SIM_HTTP_DEBUG || dotenv.MING_SIM_HTTP_DEBUG }
      : {}),
    MING_SIM_ELECTRON: "1",
    MING_SIM_USER_DATA_DIR: path.join(app.getPath("userData"), "python-data"),
    PYTHONUNBUFFERED: "1",
    // Windows 上 Python 子进程 stdout/stderr 默认按 GBK 控制台代码页编码，print 含
    // ⏎/emoji 等非 GBK 字符会抛 UnicodeEncodeError，导致推演 agent 整体崩→只剩简化邸报。
    // 强制 UTF-8（PYTHONUTF8=1 开 UTF-8 模式，PYTHONIOENCODING 兜底）。mac 默认 UTF-8 无影响。
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const spawnSpec = backendSpawnSpec();
  const backendArgs = [...spawnSpec.args, "--host", host, "--port", String(port)];

  backend = spawn(spawnSpec.command, backendArgs, {
    cwd: spawnSpec.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // 排障：把后端 stdout/stderr 原样落到 userData/electron.log（捕获 Python logging 初始化前的
  // 早期崩溃 + Electron 侧报错）。注意：后端自己另写一份结构化 backend.log 到
  // <userData>/python-data/backend.log（web_app._install_backend_log_handler），调试面板读那个。
  // 这里这份是「裸 stdout 捕获」，作早期崩溃兜底，二者不冲突。
  let backendLogStream = null;
  const backendLogPath = path.join(app.getPath("userData"), "electron.log");
  try {
    backendLogStream = fs.createWriteStream(backendLogPath, { flags: "w" });
    log(`electron stdout capture → ${backendLogPath}`);
  } catch (e) {
    warn("open electron.log failed:", e instanceof Error ? e.message : String(e));
  }

  // 启动头：把端口/URL/关键路径明确打到 backend.log 顶部。端口是 findOpenPort() 随机选的空闲端口，
  // 每次启动不同 —— 这一段让玩家/排障时打开 backend.log 第一眼就知道服务在哪个端口、存档在哪。
  const startupBanner = [
    "==================== MingSalvageSim 启动 ====================",
    `  packaged   : ${isPackaged}`,
    `  platform   : ${os.platform()} ${os.arch()}`,
    `  host:port  : ${host}:${port}`,
    `  url        : http://${host}:${port}`,
    `  backend exe: ${spawnSpec.command}`,
    `  userData   : ${app.getPath("userData")}`,
    `  backend.log: ${backendLogPath}`,
    `  python data: ${env.MING_SIM_USER_DATA_DIR}`,
    "============================================================",
    "",
  ].join("\n");
  process.stdout.write(startupBanner);
  backendLogStream?.write(startupBanner);
  backend.stdout.on("data", (chunk) => {
    process.stdout.write(`[fastapi] ${chunk}`);
    backendLogStream?.write(chunk);
  });
  backend.stderr.on("data", (chunk) => {
    process.stderr.write(`[fastapi] ${chunk}`);
    backendLogStream?.write(chunk);
  });
  backend.on("exit", (code, signal) => {
    log(`FastAPI exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    backend = null;
    if (!app.isQuitting) app.quit();
  });

  await waitForBackend(port);
  log(`FastAPI ready at http://${host}:${port}`);
  return port;
};

const stopBackend = () => {
  if (!backend) return;
  const child = backend;
  backend = null;
  if (child.killed) return;
  if (os.platform() === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"]);
  } else {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 3000).unref();
  }
};

// Steam 验票 → auth server 发 session token + 代理 LLM 配置 → 注入本地后端。
// 任何失败只 warn：回落到现状（玩家在设置页手填 key）。
const bootstrapSteamLlm = async (port) => {
  try {
    const result = await steam.authenticateWithServer({});
    if (!result.ok || !result.data || typeof result.data !== "object") {
      warn(`Steam LLM bootstrap skipped: ${result.error || "Steam auth failed"}`);
      return false;
    }
    const data = result.data;
    // 新模式：auth server 返回该 Steam 用户的专属 new-api key（api_key + quota_path）；
    // 旧模式：HMAC session_token 走透传代理。两者注入后端的方式相同。
    const apiKey = data.api_key || data.session_token;
    if (!apiKey || !data.llm || !data.llm.base_url || !data.llm.model) {
      warn("Steam LLM bootstrap skipped: auth server did not return a proxy session.");
      return false;
    }
    let quotaUrl = "";
    if (data.quota_path) {
      try {
        quotaUrl = new URL(data.quota_path, steam.getDefaultAuthUrl()).toString();
      } catch {
        quotaUrl = "";
      }
    }
    const response = await fetch(`http://${host}:${port}/api/steam/llm_session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        base_url: data.llm.base_url,
        model: data.llm.model,
        advanced_model: data.llm.advanced_model || "",
        models: Array.isArray(data.llm.models) ? data.llm.models : [],
        expires_at: data.session_expires_at || 0,
        quota_url: quotaUrl,
      }),
    });
    if (!response.ok) {
      warn(`Steam LLM bootstrap failed: backend returned HTTP ${response.status}`);
      return false;
    }
    log("Steam LLM session injected into backend.");
    return true;
  } catch (error) {
    warn("Steam LLM bootstrap failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
};

const bootstrapSteamLlmWithTimeout = (port, timeoutMs = 8000) =>
  Promise.race([
    bootstrapSteamLlm(port),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs).unref?.()),
  ]);

const scheduleSteamLlmRenewal = (port) => {
  const sixHours = 6 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    bootstrapSteamLlm(port);
  }, sixHours);
  timer.unref?.();
};

const registerWindowIpc = () => {
  ipcMain.handle("app:isFullscreen", () => Boolean(mainWindow?.isFullScreen()));
  ipcMain.handle("app:setFullscreen", (_event, value) => {
    const next = Boolean(value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(next);
    }
    writeWindowPrefs({ fullscreen: next });
    return next;
  });
};

const registerSteamIpc = () => {
  ipcMain.handle("steam:getStatus", () => steam.getStatus());
  ipcMain.handle("steam:getAuthTicket", (_event, identity) => steam.getAuthTicket(identity));
  ipcMain.handle("steam:cancelAuthTicket", (_event, ticketId) => steam.cancelAuthTicket(ticketId));
  ipcMain.handle("steam:authenticateWithServer", (_event, options) => steam.authenticateWithServer(options));
  ipcMain.handle("steam:addStatInt", (_event, name, delta) => steam.addStatInt(name, delta));
  ipcMain.handle("steam:setStatInt", (_event, name, value) => steam.setStatInt(name, value));
  ipcMain.handle("steam:flushStats", () => steam.flushStats());
};

// 充值：注册 Steam 微交易授权回调，玩家在游戏内授权框点确认/取消后，把结果转给渲染层
// （渲染层据 authorized 调后端 /api/steam/topup/finalize）。Steam 不可用时是 noop，不影响其他功能。
const registerMicroTxnForwarding = () => {
  steam.registerMicroTxnCallback((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("steam:microtxnAuthorizationResponse", payload);
    }
  });
};

const createWindow = async (port) => {
  const startFullscreen = readWindowPrefs().fullscreen === true;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    fullscreen: startFullscreen,
    backgroundColor: "#160f0a",
    icon: path.join(__dirname, "..", "build", os.platform() === "win32" ? "icon.ico" : "icon.png"),
    show: false,
    // Windows/Linux 上隐藏默认应用菜单栏（File/Edit/View…），按 Alt 也不弹出。
    autoHideMenuBar: true,
    menuBarVisible: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 允许背景音乐进游戏即自动播放（否则 Chromium 默认要先有用户手势才出声）。
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Windows 上 Electron 偶发：窗口显示了但 WebContents 拿不到键盘/输入焦点 → 所有
  // input/textarea 点了不聚焦、打不出字。不止首次 show() 会犯，alt-tab 切回、最小化恢复、
  // 退出全屏后也会复发（所以是「有时候」）。统一在每个「窗口拿到焦点/显示/退出全屏」的
  // 时机把焦点重新打到 WebContents 上，而不是只在启动时打一次。mac WKWebView 本就正常，无副作用。
  //
  // 有一类更顽固的失活：退游戏/切后台再切回时，OS 窗口有焦点（isFocused=true）但渲染层
  // Chromium frame 失焦（document.hasFocus=false）——两者不同步。此时单纯 wc.focus()/
  // window.focus() 打不破这个假死（实测无效），唯一可靠的复位是「模拟用户手动切窗口」：
  // mainWindow.blur() 让 OS 窗口真失焦 → 延迟 → mainWindow.focus() 重新聚焦，触发完整的
  // OS 级 blur→focus 事件链，重置 frame 焦点。但这记重招会自激（focus 事件里再 blur→focus
  // 会循环），所以：① 先试轻量 wc.focus()，② 下一帧确认仍未真聚焦才升级到 blur→focus，
  // ③ 用 forcingRefocus 标志在重招期间短路 focus 监听，防循环。
  let forcingRefocus = false;

  const refocusWebContents = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (!wc.isFocused()) wc.focus();
  };

  // 重招：真失焦再聚焦，打破「窗口有焦点但 frame 失焦」的假死。仅在轻量手段无效时升级调用。
  const forceRefocusByBlurFocus = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (forcingRefocus) return; // 防重入：blur()/focus() 自身会触发 focus 监听
    forcingRefocus = true;
    mainWindow.blur(); // 让 OS 窗口真失焦（等价用户切走）
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        forcingRefocus = false;
        return;
      }
      mainWindow.focus(); // 重新聚焦，触发完整 OS blur→focus 链，复位 frame 焦点
      refocusWebContents();
      forcingRefocus = false;
    }, 60); // 给 OS 一帧多的时间真正 dispatch blur，再 focus 才能形成完整事件链
  };

  // 窗口拿到焦点/显示/恢复后：先轻量补焦，下一帧若渲染层仍没真聚焦，升级到 blur→focus 重招。
  const ensureFocusFixed = () => {
    if (forcingRefocus) return; // 重招进行中，别插队
    refocusWebContents(); // ① 先试轻量
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    setTimeout(() => {
      if (forcingRefocus || !mainWindow || mainWindow.isDestroyed()) return;
      if (wc.isDestroyed()) return;
      // ② 询问渲染层 document 是否真拿到焦点（wc.isFocused 在这种假死下会骗人，问 DOM 更准）
      wc.executeJavaScript("document.hasFocus()", true)
        .then((hasFocus) => {
          if (hasFocus === false) forceRefocusByBlurFocus(); // ③ 升级重招
        })
        .catch(() => {
          /* 页面可能尚未加载，忽略；下次焦点事件再兜 */
        });
    }, 50);
  };

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    refocusWebContents();
  });
  // 窗口每次重新获得焦点（alt-tab 切回、点回程序、从最小化恢复）→ 把焦点接力给 WebContents。
  // 走 ensureFocusFixed：轻量补焦 + 渲染层若仍失活则升级 blur→focus 重招（治退后台切回打不了字）。
  mainWindow.on("focus", ensureFocusFixed);
  mainWindow.on("show", ensureFocusFixed);
  mainWindow.on("restore", ensureFocusFixed);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // 用户用 OS 快捷键（F11 / mac 全屏按钮）切全屏时，也把偏好落盘，下次启动保持一致。
  mainWindow.on("enter-full-screen", () => writeWindowPrefs({ fullscreen: true }));
  mainWindow.on("leave-full-screen", () => {
    writeWindowPrefs({ fullscreen: false });
    // 退出全屏后 Windows 也会丢 WebContents 焦点，补一刀。
    refocusWebContents();
  });

  const apiBase = `http://${host}:${port}`;
  await mainWindow.loadURL(`${apiBase}?api=${encodeURIComponent(apiBase)}`);

  // BGM 进游戏即响：首屏 audio.play() 在无用户手势时会被 Chromium 拒（即便关了 autoplay-policy，
  // 页面初次加载且 WebContents 未拿到焦点这一刻常不可靠），表现为「要点一下才有声音」。
  // 用 executeJavaScript 的 userGesture=true 形参以「带用户手势」身份调前端暴露的 __bgmEnsurePlaying()，
  // 让首播合法。注意 __bgmEnsurePlaying 要等 React 挂载（getBgmCtl 跑过）才存在，dom-ready 那一刻
  // 常还没就绪 → 那一刀会打空（表现为「保存后重进不自动播」）。故轮询重试到它就绪且播成功为止，
  // 最多 ~6s。失败只 warn（前端的首手势补播仍兜底）。
  kickBgmAutoplay(mainWindow.webContents);
};

// 反复以 user-gesture 触发前端 __bgmEnsurePlaying()，直到它就绪并返回 true（已起播）或超时。
const kickBgmAutoplay = (webContents) => {
  let tries = 0;
  const maxTries = 30; // 30 × 200ms ≈ 6s，覆盖冷启动 React 挂载 + audio 起播
  const tick = () => {
    if (!webContents || webContents.isDestroyed()) return;
    webContents
      // 返回值：函数不存在→undefined（未就绪，重试）；起播成功→true；被拦/未开→false。
      .executeJavaScript("(window.__bgmEnsurePlaying ? !!window.__bgmEnsurePlaying() : undefined)", true)
      .then((result) => {
        tries += 1;
        if (result === true) return; // 已起播，停
        if (tries >= maxTries) return; // 超时放弃，交首手势兜底
        setTimeout(tick, 200);
      })
      .catch((e) => {
        tries += 1;
        if (tries < maxTries) {
          setTimeout(tick, 200);
        } else {
          warn("bgm autoplay kick failed:", e instanceof Error ? e.message : String(e));
        }
      });
  };
  tick();
};

app.whenReady().then(async () => {
  // 彻底移除默认应用菜单（Win/Linux 顶部菜单栏、mac 系统菜单栏的开发项），
  // 玩家版不需要 File/Edit/View/Reload/Toggle DevTools 这些浏览器壳菜单。
  Menu.setApplicationMenu(null);

  if (isPackaged && steam.restartAppIfNecessary()) {
    log("Steam restart requested, quitting so Steam can relaunch the app.");
    app.quit();
    return;
  }
  registerSteamIpc();
  registerWindowIpc();
  const status = steam.getStatus();
  if (status.available) {
    log(`Steam user ${status.personaName || "(unknown)"} appId=${status.appId}`);
  } else {
    warn(`Steam unavailable: ${status.error || "unknown error"}`);
  }

  try {
    const port = await startBackend();
    const injected = await bootstrapSteamLlmWithTimeout(port);
    if (injected) scheduleSteamLlmRenewal(port);
    await createWindow(port);
    registerMicroTxnForwarding();
  } catch (error) {
    warn(error instanceof Error ? error.stack || error.message : String(error));
    stopBackend();
    app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopBackend();
});

app.on("window-all-closed", () => {
  app.quit();
});
