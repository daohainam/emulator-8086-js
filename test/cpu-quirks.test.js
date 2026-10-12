// CPU conformance probes: decode coverage, strict-8086 quirks, 186 opt-in, interrupts, HLT.
// Expected values are real 8086 (or 80186 where stated) behaviour.
import { describe, expect } from 'vitest';
import { executeStep } from '../src/CPU8086.js';
import { makeEngine, makeRegistrar, run, runRaw, setIvt, word, CODE_ADDR } from './helpers.js';

// Known-open defects (expected failures). Remove a name when the defect is fixed.
const OPEN = new Set([]);
const t = makeRegistrar(OPEN);

const IVT_TARGET = 0x2000;
const pendingPic = (imr = 0xFF) => {
    const pic = { imr, pending: false, hasPendingInterrupt: () => pic.pending, acknowledge: () => { pic.pending = false; return 8; } };
    return pic;
};
const model186 = (e) => { e.cpuModel = '186'; };

describe('decode coverage (8086)', () => {
    t('8F /0 POP r/m16 pops into memory', () => {
        const e = run([0x50, 0x8F, 0x06, 0x00, 0x02], (e) => { e.reg.AX = 0x1234; }, {}, 2);
        expect(word(e, 0x200)).toBe(0x1234);
        expect(e.reg.SP).toBe(0xFFFE);
    });
    t('A0 MOV AL,[moffs]', () => {
        const e = run([0xA0, 0x00, 0x02], (e) => { e.mem[0x200] = 0x55; e.reg.AX = 0xAA00; });
        expect(e.reg.AX).toBe(0xAA55);
        expect(e.reg.IP).toBe(CODE_ADDR + 3);
    });
    t('A1 MOV AX,[moffs]', () => {
        const e = run([0xA1, 0x00, 0x02], (e) => { e.mem[0x200] = 0x34; e.mem[0x201] = 0x12; });
        expect(e.reg.AX).toBe(0x1234);
    });
    t('A2 MOV [moffs],AL', () => {
        const e = run([0xA2, 0x00, 0x02], (e) => { e.reg.AX = 0x1299; });
        expect(e.mem[0x200]).toBe(0x99);
        expect(e.mem[0x201]).toBe(0);
    });
    t('A3 MOV [moffs],AX', () => {
        const e = run([0xA3, 0x00, 0x02], (e) => { e.reg.AX = 0x1299; });
        expect(word(e, 0x200)).toBe(0x1299);
    });
    t('A1 honours a segment override', () => {
        const e = run([0x26, 0xA1, 0x00, 0x02], (e) => { e.reg.ES = 0x1000; e.mem[0x10200] = 0x34; e.mem[0x10201] = 0x12; });
        expect(e.reg.AX).toBe(0x1234);
    });
    t('FF /3 CALL far [m]', () => {
        const e = run([0xFF, 0x1F], (e) => { e.reg.BX = 0x300; e.mem.set([0x34, 0x12, 0x78, 0x56], 0x300); });
        expect([e.reg.CS, e.reg.IP]).toEqual([0x5678, 0x1234]);
        expect(e.reg.SP).toBe(0xFFFA);
        expect(word(e, 0xFFFA)).toBe(CODE_ADDR + 2);
        expect(word(e, 0xFFFC)).toBe(0);
    });
    t('FF /5 JMP far [m]', () => {
        const e = run([0xFF, 0x2F], (e) => { e.reg.BX = 0x300; e.mem.set([0x34, 0x12, 0x78, 0x56], 0x300); });
        expect([e.reg.CS, e.reg.IP]).toEqual([0x5678, 0x1234]);
        expect(e.reg.SP).toBe(0xFFFE);
    });
    t('ESC (D8-DF) consumes its ModRM and does nothing', () => {
        expect(run([0xD8, 0xC1]).reg.IP).toBe(CODE_ADDR + 2);
        const e = run([0xDD, 0x06, 0x00, 0x02]);
        expect(e.reg.IP).toBe(CODE_ADDR + 4);
        expect(e.reg.SP).toBe(0xFFFE);
    });
    t('D6 SALC sets AL from CF', () => {
        expect(run([0xD6], (e) => { e.flags.CF = 1; e.reg.AX = 0x1200; }).reg.AX).toBe(0x12FF);
        expect(run([0xD6], (e) => { e.flags.CF = 0; e.reg.AX = 0x12FF; }).reg.AX).toBe(0x1200);
    });
});

describe('undocumented 8086 aliases', () => {
    t('60-6F alias the conditional jumps 70-7F', () => {
        expect(run([0x60, 0x05], (e) => { e.flags.OF = 1; }).reg.IP).toBe(CODE_ADDR + 7);
        expect(run([0x6F, 0x05], (e) => { e.flags.ZF = 0; e.flags.SF = 0; e.flags.OF = 0; }).reg.IP).toBe(CODE_ADDR + 7);
    });
    t('C0/C1 alias near RET', () => {
        const e = run([0xC1], (e) => { e.reg.SP = 0x200; e.mem[0x200] = 0x00; e.mem[0x201] = 0x30; });
        expect([e.reg.IP, e.reg.SP]).toEqual([0x3000, 0x202]);
        const f = run([0xC0, 0x04, 0x00], (e) => { e.reg.SP = 0x200; e.mem[0x200] = 0x00; e.mem[0x201] = 0x30; });
        expect([f.reg.IP, f.reg.SP]).toEqual([0x3000, 0x206]);
    });
    t('C8/C9 alias far RET', () => {
        const e = run([0xC9], (e) => { e.reg.SP = 0x200; e.mem.set([0x00, 0x30, 0x00, 0x10], 0x200); });
        expect([e.reg.CS, e.reg.IP, e.reg.SP]).toEqual([0x1000, 0x3000, 0x204]);
    });
    t('0F is POP CS', () => {
        const e = run([0x0F], (e) => { e.reg.SP = 0x200; e.mem.set([0x00, 0x10], 0x200); });
        expect([e.reg.CS, e.reg.SP]).toEqual([0x1000, 0x202]);
    });
    t('F1 is an alias of LOCK', () => {
        expect(run([0xF1, 0x90]).reg.IP).toBe(CODE_ADDR + 2);
    });
});

describe('flags image and trap flag', () => {
    t('PUSHF pushes the 8086 flags image (bit 1 and bits 12-15 set)', () => {
        const a = run([0x9C, 0x58], (e) => { e.flags.IF = 0; }, {}, 2);
        expect(a.reg.AX).toBe(0xF002);
        const b = run([0x9C, 0x58], (e) => { e.flags.IF = 1; e.flags.CF = 1; e.flags.ZF = 1; }, {}, 2);
        expect(b.reg.AX).toBe(0xF243);
    });
    t('POPF round-trips TF', () => {
        // raw stepping: with TF set, a real CPU would trap after each instruction
        const e = runRaw([0x9D, 0x9C, 0x58], (e) => { e.reg.SP = 0x200; e.mem[0x200] = 0x00; e.mem[0x201] = 0x01; }, 3);
        expect(e.reg.AX & 0x0100).toBe(0x0100);
    });
    t('TF raises INT 1 after the next instruction and is cleared on entry', () => {
        const e = run([0x90], (e) => { e.flags.TF = 1; setIvt(e, 1, 0, IVT_TARGET); });
        expect([e.reg.CS, e.reg.IP]).toEqual([0, IVT_TARGET]);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR + 1);
        expect(word(e, e.reg.SP + 4) & 0x0100).toBe(0x0100);
        expect([e.flags.TF, e.flags.IF]).toEqual([0, 0]);
    });
});

describe('strict 8086 arithmetic quirks', () => {
    t('IDIV byte quotient -128 raises #DE', () => {
        const e = run([0xF6, 0xFB], (e) => { e.reg.AX = 0xFF80; e.reg.BX = 1; setIvt(e, 0, 0, IVT_TARGET); });
        expect(e.reg.IP).toBe(IVT_TARGET);
    });
    t('IDIV byte quotient -127 is accepted', () => {
        const e = run([0xF6, 0xFB], (e) => { e.reg.AX = 0xFF81; e.reg.BX = 1; setIvt(e, 0, 0, IVT_TARGET); });
        expect(e.reg.AX).toBe(0x0081);
        expect(e.reg.IP).toBe(CODE_ADDR + 2);
    });
    t('IDIV word quotient -32768 raises #DE', () => {
        const e = run([0xF7, 0xFB], (e) => { e.reg.DX = 0xFFFF; e.reg.AX = 0x8000; e.reg.BX = 1; setIvt(e, 0, 0, IVT_TARGET); });
        expect(e.reg.IP).toBe(IVT_TARGET);
    });
    t('DIV by zero pushes the address after the instruction (8086)', () => {
        const e = run([0xF6, 0xF3], (e) => { e.reg.AX = 5; e.reg.BX = 0; setIvt(e, 0, 0, IVT_TARGET); });
        expect(e.reg.IP).toBe(IVT_TARGET);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR + 2);
    });
    t('shift count is not masked on the 8086 (SHL AX,CL with CL=33)', () => {
        const e = run([0xD3, 0xE0], (e) => { e.reg.AX = 1; e.reg.CX = 33; });
        expect(e.reg.AX).toBe(0);
        expect(e.flags.CF).toBe(0);
    });
    t('SHR AX,CL with CL=16 shifts everything out', () => {
        const e = run([0xD3, 0xE8], (e) => { e.reg.AX = 0x8000; e.reg.CX = 16; });
        expect([e.reg.AX, e.flags.CF]).toEqual([0, 1]);
    });
    t('PUSH SP pushes the decremented value on the 8086', () => {
        const e = run([0x54], (e) => { e.reg.SP = 0x200; });
        expect(word(e, 0x1FE)).toBe(0x1FE);
    });
    t('CALL SP reads its operand before pushing', () => {
        const e = run([0xFF, 0xD4], (e) => { e.reg.SP = 0x200; });
        expect(e.reg.IP).toBe(0x200);
    });
    t('LDS with a register operand does not throw', () => {
        expect(() => run([0xC5, 0xC0])).not.toThrow();
    });
    t('MOV Sreg with reg field > 3 uses reg&3 and creates no junk register', () => {
        const before = Object.keys(makeEngine().reg);
        const e = run([0x8E, 0xE0], (e) => { e.reg.AX = 0x1234; });
        expect(Object.keys(e.reg)).toEqual(before);
        expect(e.reg.ES).toBe(0x1234);
    });
});

describe('segment / physical wrap', () => {
    t('word read at offset FFFF wraps inside the segment', () => {
        const e = run([0x8B, 0x1E, 0xFF, 0xFF], (e) => { e.mem[0xFFFF] = 0x11; e.mem[0x10000] = 0x22; e.mem[0] = 0x33; });
        expect(e.reg.BX).toBe(0x3311);
    });
    t('word write at offset FFFF wraps inside the segment', () => {
        const e = run([0x89, 0x1E, 0xFF, 0xFF], (e) => { e.reg.BX = 0xAABB; });
        expect([e.mem[0xFFFF], e.mem[0], e.mem[0x10000]]).toEqual([0xBB, 0xAA, 0]);
    });
    t('word read across physical FFFFF wraps to 0', () => {
        const e = run([0x8B, 0x1E, 0x0F, 0x00], (e) => { e.reg.DS = 0xFFFF; e.mem[0xFFFFF] = 0x11; e.mem[0] = 0x22; });
        expect(e.reg.BX).toBe(0x2211);
    });
});

describe('interrupts', () => {
    t('INT n always vectors through the IVT (INT 10h hook)', () => {
        const e = run([0xCD, 0x10], (e) => { setIvt(e, 0x10, 0, 0x5000); e.reg.AX = 0x0E41; });
        expect([e.reg.CS, e.reg.IP, e.reg.SP]).toEqual([0, 0x5000, 0xFFF8]);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR + 2);
    });
    t('INT n clears IF', () => {
        const e = run([0xCD, 0x21], (e) => { setIvt(e, 0x21, 0, 0x5000); e.flags.IF = 1; });
        expect(e.flags.IF).toBe(0);
    });
    t('STI delays interrupt recognition by one instruction', () => {
        const pic = pendingPic(0x00);
        const e = run([0xFB, 0x90, 0xF4], (e) => { e.flags.IF = 0; setIvt(e, 8, 0, IVT_TARGET); pic.pending = true; }, { pic }, 1);
        expect(e.reg.IP).toBe(CODE_ADDR + 1);
        executeStep(e, { pic });
        expect(e.reg.IP).toBe(IVT_TARGET);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR + 2);
    });
    t('MOV SS also delays interrupt recognition by one instruction', () => {
        const pic = pendingPic(0x00);
        const e = run([0x8E, 0xD0, 0x90], (e) => { setIvt(e, 8, 0, IVT_TARGET); pic.pending = true; }, { pic }, 1);
        expect(e.reg.IP).toBe(CODE_ADDR + 2);
        executeStep(e, { pic });
        expect(e.reg.IP).toBe(IVT_TARGET);
    });
    t('hardware IRQ pushes FLAGS/CS/IP and clears IF', () => {
        const pic = pendingPic(0x00);
        const e = run([0x90], (e) => { setIvt(e, 8, 0, IVT_TARGET); pic.pending = true; }, { pic });
        expect(e.reg.IP).toBe(IVT_TARGET);
        expect(e.flags.IF).toBe(0);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR + 1);
        expect(word(e, e.reg.SP + 4) & 0x0200).toBe(0x0200);
    });
});

describe('HLT', () => {
    t('stops when IF=0', () => {
        const e = makeEngine(); e.mem[CODE_ADDR] = 0xF4; e.flags.IF = 0;
        expect(executeStep(e, { pic: pendingPic(0x00) })).toBe(false);
    });
    t('stops when no IRQ source is unmasked', () => {
        const e = makeEngine(); e.mem[CODE_ADDR] = 0xF4;
        expect(executeStep(e, { pic: pendingPic(0xFF) })).toBe(false);
    });
    t('waits for an unmasked IRQ, then resumes after the HLT', () => {
        const pic = pendingPic(0xFE);
        const e = makeEngine(); e.mem[CODE_ADDR] = 0xF4; setIvt(e, 8, 0, IVT_TARGET);
        expect(executeStep(e, { pic })).toBe(true);
        expect(e.halted).toBe(true);
        expect(e.reg.IP).toBe(CODE_ADDR + 1);
        expect(executeStep(e, { pic })).toBe(true);
        expect(e.reg.IP).toBe(CODE_ADDR + 1);
        pic.pending = true;
        expect(executeStep(e, { pic })).toBe(true);
        expect(e.reg.IP).toBe(IVT_TARGET);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR + 1);
        expect(e.halted).toBeFalsy();
    });
});

describe('string instructions (regression guards)', () => {
    t('REP MOVSB copies CX bytes, one iteration per step', () => {
        const e = run([0xF3, 0xA4], (e) => { e.reg.CX = 3; e.reg.SI = 0x300; e.reg.DI = 0x400; e.mem.set([1, 2, 3], 0x300); }, {}, 3);
        expect([...e.mem.slice(0x400, 0x403)]).toEqual([1, 2, 3]);
        expect(e.reg.CX).toBe(0);
        expect(e.reg.IP).toBe(CODE_ADDR + 2);
    });
    t('REPE CMPSB stops at the first mismatch', () => {
        const e = run([0xF3, 0xA6], (e) => { e.reg.CX = 5; e.reg.SI = 0x300; e.reg.DI = 0x400; e.mem.set([1, 2, 9, 4], 0x300); e.mem.set([1, 2, 3, 4], 0x400); }, {}, 3);
        expect(e.reg.CX).toBe(2);
        expect(e.flags.ZF).toBe(0);
        expect(e.reg.IP).toBe(CODE_ADDR + 2);
    });
});

describe('80186 opt-in model', () => {
    t('PUSH imm16 / imm8 (sign-extended)', () => {
        const a = run([0x68, 0x34, 0x12], model186);
        expect(word(a, a.reg.SP)).toBe(0x1234);
        const b = run([0x6A, 0xFF], model186);
        expect(word(b, b.reg.SP)).toBe(0xFFFF);
    });
    t('shift count is masked to 5 bits', () => {
        const e = run([0xD3, 0xE0], (e) => { model186(e); e.reg.AX = 1; e.reg.CX = 33; });
        expect(e.reg.AX).toBe(2);
    });
    t('PUSH SP pushes the old value', () => {
        const e = run([0x54], (e) => { model186(e); e.reg.SP = 0x200; });
        expect(word(e, 0x1FE)).toBe(0x200);
    });
    t('SHL r/m,imm8 (C1)', () => {
        const e = run([0xC1, 0xE0, 0x04], (e) => { model186(e); e.reg.AX = 0x0003; });
        expect(e.reg.AX).toBe(0x0030);
    });
    t('ENTER / LEAVE build and tear down a frame', () => {
        const e = run([0xC8, 0x04, 0x00, 0x00, 0xC9], (e) => { model186(e); e.reg.BP = 0x1111; }, {}, 1);
        expect(e.reg.BP).toBe(0xFFFC);
        expect(e.reg.SP).toBe(0xFFF8);
        executeStep(e, {});
        expect([e.reg.BP, e.reg.SP]).toEqual([0x1111, 0xFFFE]);
    });
    t('IMUL r16,r/m16,imm16', () => {
        const e = run([0x69, 0xC3, 0x03, 0x00], (e) => { model186(e); e.reg.BX = 5; });
        expect(e.reg.AX).toBe(15);
    });
    t('BOUND faults with INT 5 only when out of range', () => {
        const setup = (ax) => (e) => { model186(e); e.reg.AX = ax; e.reg.BX = 0x300; e.mem.set([0x10, 0x00, 0x20, 0x00], 0x300); setIvt(e, 5, 0, IVT_TARGET); };
        expect(run([0x62, 0x07], setup(0x15)).reg.IP).toBe(CODE_ADDR + 2);
        expect(run([0x62, 0x07], setup(0x30)).reg.IP).toBe(IVT_TARGET);
    });
    t('INSB / OUTSB move bytes between ports and memory', () => {
        const bus = { read: () => 0x5A, write: (p, v) => { bus.last = [p, v]; } };
        const a = run([0x6C], (e) => { model186(e); e.reg.DX = 0x60; e.reg.DI = 0x400; }, { bus });
        expect([a.mem[0x400], a.reg.DI]).toEqual([0x5A, 0x401]);
        const b = run([0x6E], (e) => { model186(e); e.reg.DX = 0x61; e.reg.SI = 0x300; e.mem[0x300] = 0x77; }, { bus });
        expect(bus.last).toEqual([0x61, 0x77]);
        expect(b.reg.SI).toBe(0x301);
    });
    t('undefined opcode raises INT 6 at the faulting instruction', () => {
        const e = run([0x0F], (e) => { model186(e); setIvt(e, 6, 0, IVT_TARGET); });
        expect(e.reg.IP).toBe(IVT_TARGET);
        expect(word(e, e.reg.SP)).toBe(CODE_ADDR);
    });
});

describe('raw step (no IRQ polling)', () => {
    t('NOP advances IP by one', () => {
        expect(runRaw([0x90]).reg.IP).toBe(CODE_ADDR + 1);
    });
});
