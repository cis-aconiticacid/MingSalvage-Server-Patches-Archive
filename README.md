# MingSalvage Server Patches Archive

This private repository preserves custom deployment scripts and patch packages written around a MingSalvageSim installation.

## Included material

- `server/`: Docker deployment, startup scripts, a Python server wrapper with password gating, and an Electron main-process modification.
- `patches/`: the original mobile-chat/LLM-assistance patch package, technology-tree patch package, and their installation notes.

The patch packages contain only the modified delivery files needed to apply those changes to an existing installation.

## Exclusions

The following installation and runtime material is intentionally not included:

- game executables and Electron/Chromium runtime files;
- extracted third-party Python bytecode and dependency trees;
- certificates, private keys, passwords, and authentication material;
- databases, save games, logs, screenshots, and runtime state;
- the complete proprietary game distribution.

## Status

Archived and no longer actively maintained. These patches target the historical packaged file layout documented in their installation notes and may not apply to other versions.
