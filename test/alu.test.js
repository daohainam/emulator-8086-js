// ALU flag/result correctness against an independent bit-level reference model.
import { describe, it, expect } from 'vitest';
import { executeBinaryStep } from '../src/CPU8086.js';
import { makeEngine, CODE_ADDR } from './helpers.js';

const OPS = ['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'CMP'];

// Reference model: computed from the textbook definitions, not from the CPU source.
const reference = (op, a, b, cf, bits) => {
    const mask = (1 << bits) - 1;
    const sign = 1 << (bits - 1);
    let r, outCF = 0, outAF = 0, outOF = 0;
    if (op === 0 || op === 2) {
        const ci = op === 2 ? cf : 0;
        r = a + b + ci;
        outCF = r > mask ? 1 : 0;
        outAF = ((a & 15) + (b & 15) + ci) > 15 ? 1 : 0;
        outOF = (~(a ^ b) & (a ^ r) & sign) ? 1 : 0;
    } else if (op === 3 || op === 5 || op === 7) {
        const ci = op === 3 ? cf : 0;
        r = a - b - ci;
        outCF = r < 0 ? 1 : 0;
        outAF = ((a & 15) - (b & 15) - ci) < 0 ? 1 : 0;
        outOF = ((a ^ b) & (a ^ r) & sign) ? 1 : 0;
    } else {
        r = op === 1 ? a | b : op === 4 ? a & b : a ^ b;
    }
    r &= mask;
    let p = 0;
    for (let i = 0; i < 8; i++) p ^= (r >> i) & 1;
    return { r, CF: outCF, AF: outAF, OF: outOF, ZF: r === 0 ? 1 : 0, SF: (r & sign) ? 1 : 0, PF: p ^ 1 };
};

// One engine reused for every case: allocating a 1 MB memory per case is far too slow.
const e = makeEngine();

const check = (op, a, b, cf, bits) => {
    const word = bits === 16;
    Object.assign(e.reg, { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, SP: 0xFFFE, BP: 0, CS: 0, DS: 0, SS: 0, ES: 0, IP: CODE_ADDR });
    Object.assign(e.flags, { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 });
    // 0x80 /op r/m8(AL), imm8   or   0x81 /op r/m16(AX), imm16   (ModRM 0xC0 = register AX/AL)
    const modrm = 0xC0 | (op << 3);
    e.mem.set(word ? [0x81, modrm, b & 0xFF, b >> 8] : [0x80, modrm, b], CODE_ADDR);
    e.reg.AX = a;
    e.flags.CF = cf;
    executeBinaryStep(e, {});
    const x = reference(op, a, b, cf, bits);
    const logic = op === 1 || op === 4 || op === 6;
    const mask = (1 << bits) - 1;
    const expectRes = op === 7 ? a : x.r;
    const got = { r: e.reg.AX & mask, ...e.flags };
    const want = { r: expectRes, CF: x.CF, ZF: x.ZF, SF: x.SF, OF: x.OF, PF: x.PF, AF: logic ? 0 : x.AF };
    for (const k of ['r', 'CF', 'ZF', 'SF', 'OF', 'PF', 'AF']) {
        if (got[k] !== want[k]) return `${OPS[op]} ${bits}-bit a=${a} b=${b} cf=${cf}: ${k} got ${got[k]} want ${want[k]}`;
    }
    return null;
};

describe('ALU group 0x80/0x81 vs reference model', { timeout: 120000 }, () => {
    it('8-bit: exhaustive (all ops, all operands, both carry-in values)', () => {
        const failures = [];
        for (let op = 0; op < 8; op++) {
            for (let a = 0; a < 256; a++) {
                for (let b = 0; b < 256; b++) {
                    for (let cf = 0; cf < 2; cf++) {
                        if (cf && op !== 2 && op !== 3) continue;
                        const f = check(op, a, b, cf, 8);
                        if (f && failures.length < 5) failures.push(f);
                    }
                }
            }
        }
        expect(failures).toEqual([]);
    });

    it('16-bit: edge values and seeded random sample', () => {
        const edges = [0, 1, 2, 0x7F, 0x80, 0xFF, 0x100, 0x7FFF, 0x8000, 0x8001, 0xFFFE, 0xFFFF];
        let seed = 0x1234567;
        const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) & 0xFFFF;
        const pairs = [];
        for (const a of edges) for (const b of edges) pairs.push([a, b]);
        for (let i = 0; i < 20000; i++) pairs.push([rnd(), rnd()]);
        const failures = [];
        for (const [a, b] of pairs) {
            for (let op = 0; op < 8; op++) {
                for (let cf = 0; cf < 2; cf++) {
                    if (cf && op !== 2 && op !== 3) continue;
                    const f = check(op, a, b, cf, 16);
                    if (f && failures.length < 5) failures.push(f);
                }
            }
        }
        expect(failures).toEqual([]);
    });
});
