// BIOS ROM image generated at reset: service stubs, interrupt vector table, reset vector.
//
// Every BIOS service is a 4-byte stub in segment F000:
//
//     FE 38 <id>   host callback (FE /7 is an undefined encoding on the 8086, so it is free to use)
//     CF           IRET
//
// `INT n` goes through the IVT to the stub like any other interrupt, so guests can hook, chain to
// and replace BIOS vectors. The callback runs in JavaScript (see CPU8086.js, `e.hle`); results in CF/ZF
// are merged into the stacked FLAGS before the IRET executes, as a real BIOS does with `[bp+6]`.
import { int10 } from './int10.js';
import { int11, int12, int15, int1a, irqEoi, fatalDivide, fatalInvalidOpcode } from './misc.js';
import { int13 } from './int13.js';
import { int16 } from './int16.js';

export const ROM_SEG = 0xF000;
export const ROM_BASE = 0xF0000;
export const STUB_BASE = 0xE000;        // F000:E000 + 4 * id
export const IDLE_ENTRY = 0xE800;       // parked here after a reset: HLT; JMP back
export const DUMMY_IRET = 0xFF53;       // the classic address of the BIOS "dummy IRET"
export const RESET_VECTOR = 0xFFFF0;

export const HLE_ID = {
    DIV0: 0x01, INVALID_OP: 0x02, IRQ_EOI: 0x03,
    INT10: 0x10, INT11: 0x11, INT12: 0x12, INT13: 0x13, INT15: 0x15, INT16: 0x16, INT1A: 0x1A,
};

const HANDLERS = {
    [HLE_ID.DIV0]: fatalDivide,
    [HLE_ID.INVALID_OP]: fatalInvalidOpcode,
    [HLE_ID.IRQ_EOI]: irqEoi,
    [HLE_ID.INT10]: int10,
    [HLE_ID.INT11]: int11,
    [HLE_ID.INT12]: int12,
    [HLE_ID.INT13]: int13,
    [HLE_ID.INT15]: int15,
    [HLE_ID.INT16]: int16,
    [HLE_ID.INT1A]: int1a,
};

/** Interrupt vector -> HLE id for the vectors the BIOS services. */
const VECTOR_SERVICES = {
    0x00: HLE_ID.DIV0, 0x06: HLE_ID.INVALID_OP,
    0x10: HLE_ID.INT10, 0x11: HLE_ID.INT11, 0x12: HLE_ID.INT12, 0x13: HLE_ID.INT13,
    0x15: HLE_ID.INT15, 0x16: HLE_ID.INT16, 0x1A: HLE_ID.INT1A,
};

export const stubOffset = (id) => STUB_BASE + id * 4;

const setVector = (e, vector, seg, off) => {
    e.mem[vector * 4] = off & 0xFF;
    e.mem[vector * 4 + 1] = (off >> 8) & 0xFF;
    e.mem[vector * 4 + 2] = seg & 0xFF;
    e.mem[vector * 4 + 3] = (seg >> 8) & 0xFF;
};

/** Register a host callback and write its stub into ROM. */
export const addService = (e, id, handler) => {
    e.hle[id] = handler;
    const a = ROM_BASE + stubOffset(id);
    e.mem[a] = 0xFE; e.mem[a + 1] = 0x38; e.mem[a + 2] = id; e.mem[a + 3] = 0xCF;
};

/** Write the ROM image (stubs, idle loop, reset vector) and the interrupt vector table. */
export const installRom = (e, extraServices = {}) => {
    e.hle = [];
    const handlers = { ...HANDLERS, ...extraServices.handlers };
    for (const [id, fn] of Object.entries(handlers)) addService(e, Number(id), fn);

    e.mem[ROM_BASE + DUMMY_IRET] = 0xCF;
    e.mem.set([0xF4, 0xEB, 0xFD], ROM_BASE + IDLE_ENTRY);                       // HLT ; JMP short back to HLT
    e.mem.set([0xEA, IDLE_ENTRY & 0xFF, IDLE_ENTRY >> 8, ROM_SEG & 0xFF, ROM_SEG >> 8], RESET_VECTOR); // JMP FAR F000:IDLE
    e.mem.set([...'01/01/26'].map((c) => c.charCodeAt(0)), 0xFFFF5);             // BIOS date
    e.mem[0xFFFFE] = 0xFE;                                                        // model byte: PC/XT

    const services = { ...VECTOR_SERVICES, ...extraServices.vectors };
    for (let v = 0; v < 256; v++) {
        let id = services[v];
        if (id === undefined && v >= 0x08 && v <= 0x0F) id = HLE_ID.IRQ_EOI;    // unhandled hardware IRQs still get an EOI
        if (id !== undefined) setVector(e, v, ROM_SEG, stubOffset(id));
        else setVector(e, v, ROM_SEG, DUMMY_IRET);
    }
};
