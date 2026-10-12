# Legacy standalone BIOS ROM (not used)

`bios.asm`, `int16.asm` and `bios.bin` are an earlier, NASM-built option ROM for the emulator. **The emulator does not load
them any more**: the BIOS is generated at reset by `src/bios/` (see `src/bios/rom.js`) and its services run in JavaScript
behind ROM stubs, with every `INT n` going through the interrupt vector table.

The files are kept as reference material only. `bios.bin` is stale (built before `int16.asm` was added), has no ROM
checksum, and several handlers lose their carry-flag result because they `clc`/`stc` before an `iret`. Do not rebuild it
expecting it to match the running BIOS.
