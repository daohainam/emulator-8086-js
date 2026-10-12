// End-to-end: every bundled sample assembles and produces its expected screen output.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Assembler8086 } from '../src/Assembler8086.js';
import { executeStep, VGA_BASE } from '../src/CPU8086.js';
import { enqueueKey } from '../src/bios/int16.js';
import { makeMachine } from './helpers.js';
import { startProgram, resetMachine } from '../src/Machine.js';
import { IOBus } from '../src/devices/IOBus.js';
import { PIC8259Device } from '../src/devices/PIC8259Device.js';
import { KeyboardDevice } from '../src/devices/KeyboardDevice.js';

const SAMPLES = path.join(import.meta.dirname, '..', 'samples');

const screenRows = (e) => {
    const rows = {};
    for (let r = 0; r < 25; r++) {
        let s = '';
        for (let c = 0; c < 80; c++) {
            const ch = e.mem[VGA_BASE + (r * 80 + c) * 2];
            s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' ';
        }
        if (s.trim()) rows[r] = s.trim();
    }
    return rows;
};

const runSample = (dir, { keys = [], maxSteps = 100000 } = {}) => {
    const file = fs.readdirSync(path.join(SAMPLES, dir)).find((f) => f.endsWith('.asm'));
    const asm = new Assembler8086();
    const bin = asm.assemble(fs.readFileSync(path.join(SAMPLES, dir, file), 'utf8'), { origin: 0x100 });
    const e = makeMachine();
    startProgram(e, bin, asm.origin);
    for (const [ascii, scan] of keys) enqueueKey(e, ascii, scan);
    let steps = 0;
    while (steps < maxSteps && executeStep(e, {})) steps++;
    return { e, asm, halted: steps < maxSteps };
};

describe('bundled samples', () => {
    it('hello8086 writes coloured text straight to VGA RAM', () => {
        const { e, halted, asm } = runSample('hello8086');
        expect(halted).toBe(true);
        expect(asm.warnings).toEqual([]);
        expect(screenRows(e)).toEqual({ 12: 'Hello 8086' });
    });
    it('helloworld prints through INT 10h', () => {
        const { e, halted } = runSample('helloworld');
        expect(halted).toBe(true);
        expect(screenRows(e)).toEqual({ 0: 'Hello World' });
    });
    it('reverse-string reverses the message', () => {
        const { e, halted } = runSample('reverse-string');
        expect(halted).toBe(true);
        expect(screenRows(e)).toEqual({ 0: '!yromeM oediV 6808 olleH' });
    });
    it('keyboard echoes typed keys via INT 16h', () => {
        const { e } = runSample('keyboard', { keys: [[0x68, 0x23], [0x69, 0x17]], maxSteps: 20000 });
        expect(screenRows(e)[1]).toBe('> hi');
    });
    it('bootsector assembles to 512 bytes ending in the 0xAA55 signature and prints its banner', () => {
        const file = fs.readdirSync(path.join(SAMPLES, 'bootsector')).find((f) => f.endsWith('.asm'));
        const bin = new Assembler8086().assemble(fs.readFileSync(path.join(SAMPLES, 'bootsector', file), 'utf8'));
        expect(bin.length).toBe(512);
        expect([bin[510], bin[511]]).toEqual([0x55, 0xAA]);
        const { e, halted } = runSample('bootsector');
        expect(halted).toBe(true);
        expect(screenRows(e)[0]).toBe('WELCOME TO EMULATOR-8086-JS COMPUTER');
    });

    it('int-hook counts INT 10h calls through a guest hook and chains to the BIOS', () => {
        const { e, halted } = runSample('int-hook');
        expect(halted).toBe(true);
        expect(screenRows(e)).toEqual({ 0: 'Hooked: 8' });   // one hooked call per character of 'Hooked: '
    });

    it('hlt-wait sleeps in HLT until a keyboard interrupt wakes it, then stops at CLI/HLT', () => {
        const file = path.join(SAMPLES, 'hlt-wait', 'hlt-wait.asm');
        const asm = new Assembler8086();
        const bin = asm.assemble(fs.readFileSync(file, 'utf8'), { origin: 0x100 });
        const bus = new IOBus();
        const pic = new PIC8259Device();
        const keyboard = new KeyboardDevice();
        bus.register(keyboard);
        bus.register(pic);
        const e = makeMachine();
        resetMachine(e, { bus });
        startProgram(e, bin, asm.origin);
        const ctx = { bus, pic, keyboard };

        // Run until the CPU goes to sleep in HLT waiting for IRQ1.
        let steps = 0;
        while (!e.halted && steps++ < 50000) executeStep(e, ctx);
        expect(e.halted).toBe(true);
        expect(pic.imr & 0x02).toBe(0);                       // the program unmasked IRQ1
        expect(screenRows(e)[0]).toBe('Press a key...');

        // Idle: still asleep after many more steps, still running (step returns true).
        for (let i = 0; i < 1000; i++) expect(executeStep(e, ctx)).toBe(true);
        expect(e.halted).toBe(true);

        // A key release alone (break code) wakes the CPU but the handler ignores it -> sleeps again.
        keyboard.pushScancode(0x9E); pic.pulseIRQ(1);
        for (let i = 0; i < 2000; i++) executeStep(e, ctx);
        expect(e.halted).toBe(true);
        expect(screenRows(e)[1]).toBeUndefined();

        // A key press (make code 'A' = 1Eh) -> handler stores it -> main loop prints and stops.
        keyboard.pushScancode(0x1E); pic.pulseIRQ(1);
        let alive = true;
        for (let i = 0; i < 5000 && alive; i++) alive = executeStep(e, ctx);
        expect(alive).toBe(false);                            // HLT with IF=0 stops the emulator
        expect(screenRows(e)[1]).toBe('Key!');
        expect(pic.isr).toBe(0);                              // the handler sent its EOI
    });
});
