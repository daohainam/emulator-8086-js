// Shared helpers for the CPU / assembler test suites.
import { it } from 'vitest';
import { createEngine, executeStep, executeBinaryStep } from '../src/CPU8086.js';
import { Assembler8086 } from '../src/Assembler8086.js';
import { resetMachine, startProgram } from '../src/Machine.js';

export const CODE_ADDR = 0x100;

/** Engine with IP at CODE_ADDR and tiny disks (the shared createEngine() factory is the single source of truth). */
export const makeEngine = (over = {}) => {
    const e = createEngine({ disk: new Uint8Array(512), floppy: new Uint8Array(512), ...over });
    e.reg.IP = CODE_ADDR;
    return e;
};

/** Engine with the BIOS ROM, IVT and BDA installed (what Assemble / Reset give the app). */
export const makeMachine = (over = {}) => resetMachine(makeEngine(over));

/** Assemble `src` and load it as a program on a fresh machine (CS:IP = 0000:origin). */
export const loadProgram = (src, options = {}) => {
    const asm = new Assembler8086();
    const bin = asm.assemble(src, options);
    const e = makeMachine();
    startProgram(e, bin, asm.origin);
    return { e, asm, bin };
};

/** Run until the CPU stops (HLT with nothing to wake it, or a fatal fault) or the step cap is hit. */
export const runToStop = (e, ctx = {}, maxSteps = 200000) => {
    for (let i = 0; i < maxSteps; i++) if (!executeStep(e, ctx)) return true;
    return false;
};

export const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
export const bytesHex = (u8) => [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Load `bytes` at CS:IP, apply `setup(e)`, execute `steps` instructions (with IRQ checks). */
export const run = (bytes, setup, ctx = {}, steps = 1) => {
    const e = makeEngine();
    e.mem.set(bytes, CODE_ADDR);
    if (setup) setup(e);
    for (let i = 0; i < steps; i++) executeStep(e, ctx);
    return e;
};

/** Same as run() but without hardware-interrupt checks. */
export const runRaw = (bytes, setup, steps = 1) => {
    const e = makeEngine();
    e.mem.set(bytes, CODE_ADDR);
    if (setup) setup(e);
    for (let i = 0; i < steps; i++) executeBinaryStep(e, {});
    return e;
};

export const setIvt = (e, vector, seg, off) => {
    e.mem[vector * 4] = off & 0xFF;
    e.mem[vector * 4 + 1] = (off >> 8) & 0xFF;
    e.mem[vector * 4 + 2] = seg & 0xFF;
    e.mem[vector * 4 + 3] = (seg >> 8) & 0xFF;
};

export const word = (e, phys) => e.mem[phys] | (e.mem[phys + 1] << 8);

/** Assemble `src`; returns the Uint8Array. Throws on assembler errors. */
export const assemble = (src, options = {}) => new Assembler8086().assemble(src, options);

/** Assemble with a leading `org 100h` and return the bytes as upper-case hex. */
export const asmHex = (src, options = {}) => bytesHex(assemble(`org 100h\n${src}`, options));

/** Assemble, load at the assembler origin, run until HLT (or the step cap). */
export const assembleAndRun = (src, setup, maxSteps = 10000) => {
    const asm = new Assembler8086();
    const bin = asm.assemble(src);
    const e = makeEngine();
    e.mem.set(bin, asm.origin);
    e.reg.IP = asm.origin;
    if (setup) setup(e);
    for (let i = 0; i < maxSteps; i++) {
        if (!executeStep(e, {})) return e;
    }
    throw new Error('program did not halt');
};

/**
 * Test registrar that marks known-open defects as expected failures (`it.fails`).
 * Remove a name from `open` once the underlying defect is fixed.
 * Run with TEST_ALL=1 to execute the open ones as ordinary tests and see which now pass.
 */
export const makeRegistrar = (open) => (name, fn) =>
    (open.has(name) && process.env.TEST_ALL !== '1' ? it.fails : it)(name, fn);
