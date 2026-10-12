// Runner for the hardware-generated SingleStepTests/8086 JSON test vectors.
// https://github.com/SingleStepTests/8086  (data is untrusted input: parsed as JSON only, never executed)
//
// Test schema (per README): { name, bytes, initial: {regs, ram, queue}, final: {regs, ram, queue}, cycles, ... }
//   regs : ax bx cx dx cs ss ds es sp bp si di ip flags   (final lists only registers that changed)
//   ram  : [[address, value], ...]
// metadata.json carries per-opcode `flags-mask` (bits of FLAGS that are architecturally defined).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { executeBinaryStep, packFlags, unpackFlags } from '../src/CPU8086.js';
import { makeEngine, CODE_ADDR } from './helpers.js';

const REG_KEYS = ['ax', 'bx', 'cx', 'dx', 'cs', 'ss', 'ds', 'es', 'sp', 'bp', 'si', 'di', 'ip'];
const PREFIXES = new Set([0x26, 0x2E, 0x36, 0x3E, 0xF0, 0xF1, 0xF2, 0xF3]);
const MAX_REP_STEPS = 0x20000;

/** One reusable engine; touched memory is cleared after every case. */
export const createRunner = () => {
    const e = makeEngine({ cpuModel: '8086' });
    let touched = [];

    const load = (tc) => {
        for (const a of touched) e.mem[a] = 0;
        touched = [];
        for (const k of REG_KEYS) e.reg[k.toUpperCase()] = tc.initial.regs[k] & 0xFFFF;
        unpackFlags(e, tc.initial.regs.flags);
        for (const [addr, val] of tc.initial.ram) { e.mem[addr] = val; touched.push(addr); }
        e.halted = false;
        e.inhibitIRQ = false;
    };

    const isRep = (bytes) => {
        for (const b of bytes) {
            if (!PREFIXES.has(b)) return false;
            if (b === 0xF2 || b === 0xF3) return true;
        }
        return false;
    };

    /** Execute one test vector; returns a list of mismatch descriptions (empty = pass). */
    const runCase = (tc, flagsMask = 0xFFFF) => {
        load(tc);
        const startIP = tc.initial.regs.ip & 0xFFFF;
        const rep = isRep(tc.bytes);
        let steps = 0;
        do { executeBinaryStep(e, {}); steps++; } while (rep && e.reg.IP === startIP && steps < MAX_REP_STEPS);

        const problems = [];
        const finalRegs = { ...tc.initial.regs, ...tc.final.regs };
        for (const k of REG_KEYS) {
            const got = e.reg[k.toUpperCase()] & 0xFFFF;
            if (got !== (finalRegs[k] & 0xFFFF)) problems.push(`${k}: got ${got.toString(16)} want ${(finalRegs[k] & 0xFFFF).toString(16)}`);
        }
        const gotFlags = packFlags(e) & flagsMask;
        const wantFlags = finalRegs.flags & flagsMask;
        if (gotFlags !== wantFlags) problems.push(`flags: got ${gotFlags.toString(16)} want ${wantFlags.toString(16)} (mask ${flagsMask.toString(16)})`);

        const finalRam = new Map(tc.final.ram);
        for (const [addr, val] of finalRam) {
            if (e.mem[addr] !== val) problems.push(`ram[${addr.toString(16)}]: got ${e.mem[addr].toString(16)} want ${val.toString(16)}`);
            touched.push(addr);
        }
        for (const [addr, val] of tc.initial.ram) {
            if (!finalRam.has(addr) && e.mem[addr] !== val) problems.push(`ram[${addr.toString(16)}] changed unexpectedly`);
        }
        return problems;
    };

    return { runCase, engine: e };
};

/** Resolve the architecturally-defined flag mask for a file such as `F6.7.json` / `00.json.gz`. */
export const flagsMaskFor = (fileName, metadata) => {
    const key = fileName.replace(/\.json(\.gz)?$/, '');
    const [op, ext] = key.split('.');
    const entry = metadata?.opcodes?.[op] ?? metadata?.[op];
    if (!entry) return 0xFFFF;
    const sub = ext !== undefined ? entry.reg?.[ext] : undefined;
    const mask = sub?.['flags-mask'] ?? entry['flags-mask'];
    return typeof mask === 'number' ? mask : 0xFFFF;
};

export const readTestFile = (file) => {
    const raw = fs.readFileSync(file);
    const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text);
};

export const listTestFiles = (dir) =>
    fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => /\.json(\.gz)?$/.test(f) && !f.startsWith('metadata')).sort()
        : [];

export const readMetadata = (dir) => {
    const f = path.join(dir, 'metadata.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

export { CODE_ADDR };
