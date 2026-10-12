// Machine-level reset and program loading: one code path for Reset, Assemble and Boot.
import { SECTOR_SIZE } from './CPU8086.js';
import { initBda } from './bios/bda.js';
import { clearScreen } from './bios/int10.js';
import { installRom, RESET_VECTOR } from './bios/rom.js';

export const BOOT_LOAD_ADDR = 0x7C00;
export const INITIAL_SP = 0xFFFE;

/**
 * Power-on state: RAM cleared, BIOS ROM / IVT / BDA rebuilt, devices reset, CPU at the reset
 * vector (FFFF:0000 -> JMP FAR to the ROM idle loop). Flags start with IF=1 like a machine whose
 * POST has finished. Disk images are preserved.
 *
 * @param {object} e - engine (createEngine())
 * @param {{ bus?: object, extraServices?: object }} [opts]
 */
export const resetMachine = (e, { bus, extraServices } = {}) => {
    e.mem.fill(0);
    initBda(e);
    clearScreen(e);
    installRom(e, extraServices);

    for (const k of Object.keys(e.reg)) e.reg[k] = 0;
    e.reg.SP = INITIAL_SP;
    e.reg.CS = RESET_VECTOR >> 4 & 0xFFFF;   // 0xFFFF
    e.reg.IP = RESET_VECTOR & 0xF;           // 0x0000
    e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0, TF: 0 };
    e.halted = false;
    e.inhibitIRQ = false;
    e.fault = null;
    if (bus) bus.reset();
    return e;
};

/** Start a flat program at CS:IP = 0000:origin (DOS .COM style, as Assemble does). */
export const startProgram = (e, bytes, origin) => {
    for (let i = 0; i < bytes.length; i++) {
        const a = origin + i;
        if (a < e.mem.length) e.mem[a] = bytes[i];
    }
    e.reg.CS = 0x0000;
    e.reg.IP = origin;
};

/** Load sector 0 of the hard disk at 0000:7C00 and start it with DL = boot drive, like a BIOS boot. */
export const bootFromDisk = (e) => {
    for (let i = 0; i < SECTOR_SIZE; i++) e.mem[BOOT_LOAD_ADDR + i] = e.disk[i];
    e.reg.CS = 0x0000;
    e.reg.IP = BOOT_LOAD_ADDR;
    e.reg.DX = 0x0080;
    e.reg.SS = 0x0000;
    e.reg.SP = BOOT_LOAD_ADDR;
};

export const hasBootSignature = (disk) => disk[SECTOR_SIZE - 2] === 0x55 && disk[SECTOR_SIZE - 1] === 0xAA;
