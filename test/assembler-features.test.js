// Assembler: expressions, data directives, symbols, jumps, addressing modes.
import { describe, it, expect } from 'vitest';
import { Assembler8086 } from '../src/Assembler8086.js';
import { asmHex, assemble, assembleAndRun } from './helpers.js';

describe('expressions', () => {
    it('NASM operators and precedence', () => {
        expect(asmHex('mov ax, 1 + 2 * 3')).toBe('B8 07 00');
        expect(asmHex('mov ax, (1 + 2) * 3')).toBe('B8 09 00');
        expect(asmHex('mov ax, 1 << 4 | 3')).toBe('B8 13 00');
        expect(asmHex('mov ax, 0xFF & ~0x0F')).toBe('B8 F0 00');
        expect(asmHex('mov ax, 17 % 5')).toBe('B8 02 00');
        expect(asmHex('mov ax, 17 / 5')).toBe('B8 03 00');
        expect(asmHex('mov ax, -1')).toBe('B8 FF FF');
    });
    it('number literal forms', () => {
        expect(asmHex('mov ax, 0x10')).toBe('B8 10 00');
        expect(asmHex('mov ax, 10h')).toBe('B8 10 00');
        expect(asmHex('mov ax, 0b101')).toBe('B8 05 00');
        expect(asmHex('mov ax, 101b')).toBe('B8 05 00');
        expect(asmHex('mov ax, 17o')).toBe('B8 0F 00');
        expect(asmHex("mov ax, 'AB'")).toBe('B8 41 42');
        expect(asmHex("mov al, 'A'")).toBe('B0 41');
    });
    it('malformed expressions are clear errors', () => {
        expect(() => asmHex('mov ax, (1 + ')).toThrow(/expression/i);
        expect(() => asmHex('mov ax, 1 +* 2')).toThrow();
    });
    it('EQU may refer to labels defined later', () => {
        const e = assembleAndRun('org 100h\nmov cx, size\nhlt\nstart: db 1,2,3,4\nend:\nsize equ end - start');
        expect(e.reg.CX).toBe(4);
    });
    it('$ and $$', () => {
        expect(asmHex('mov ax, $')).toBe('B8 00 01');
        expect(asmHex('nop\nmov ax, $ - $$')).toBe('90 B8 01 00');
    });
});

describe('data directives', () => {
    it('db with strings, numbers and expressions', () => {
        expect(asmHex("db 'AB', 0x43, 'D'+1, 10")).toBe('41 42 43 45 0A');
    });
    it('string spacing is preserved (also after a bare label)', () => {
        expect(asmHex("msg db 'a  b'")).toBe('61 20 20 62');
        expect(asmHex("times 2 db 'x  y'")).toBe('78 20 20 79 78 20 20 79');
    });
    it('dw / dd strings pad to the unit like NASM', () => {
        expect(asmHex("dw 'a'")).toBe('61 00');
        expect(asmHex("dw 'ab'")).toBe('61 62');
        expect(asmHex("dw 'abc'")).toBe('61 62 63 00');
        expect(asmHex('dd 0x12345678')).toBe('78 56 34 12');
    });
    it('dw / db with forward references', () => {
        expect(asmHex('dw later\nlater: db later - $')).toBe('02 01 00');
    });
    it('resb / resw / align', () => {
        expect(asmHex('resb 3\nresw 1')).toBe('00 00 00 00 00');
        expect(asmHex('db 1\nalign 4\ndb 2')).toBe('01 90 90 90 02');
        expect(asmHex('db 1\nalign 4, db 0\ndb 2')).toBe('01 00 00 00 02');
    });
    it('%define with a trailing comment', () => {
        expect(asmHex('%define N 7 ; seven\nmov al, N')).toBe('B0 07');
    });
});

describe('labels and symbols', () => {
    it('duplicate label is an error', () => {
        expect(() => asmHex('a: nop\na: nop')).toThrow(/already defined/i);
    });
    it('local labels work inside memory operands', () => {
        const e = assembleAndRun('org 100h\nmain:\nmov al,[.data]\nhlt\n.data: db 77');
        expect(e.reg.AX & 0xFF).toBe(77);
    });
    it('[org ...] / [bits 16] bracket forms', () => {
        expect(assemble('[bits 16]\n[org 0x7C00]\nnop')).toEqual(new Uint8Array([0x90]));
        const a = new Assembler8086(); a.assemble('[org 0x7C00]\nnop');
        expect(a.origin).toBe(0x7C00);
    });
    it('BITS 32 is rejected', () => {
        expect(() => asmHex('bits 32')).toThrow(/BITS 16/);
    });
    it('label names may equal a mnemonic when followed by a colon', () => {
        expect(asmHex('loop: nop')).toBe('90');
    });
});

describe('jumps, prefixes and addressing', () => {
    it('backward jmp beyond 127 bytes relaxes to near', () => {
        const e = assembleAndRun('org 100h\nmov cx, 3\ntop: dec cx\ntimes 200 nop\njz done\njmp top\ndone: hlt');
        expect(e.reg.CX).toBe(0);
    });
    it('jmp short / near qualifiers', () => {
        expect(asmHex('x: jmp short x')).toBe('EB FE');
        expect(asmHex('x: jmp near x')).toBe('E9 FD FF');
        expect(() => asmHex('jmp short far_away\ntimes 200 nop\nfar_away: nop')).toThrow(/range/i);
    });
    it('prefixed string instructions', () => {
        expect(asmHex('rep movsb')).toBe('F3 A4');
        expect(asmHex('repne scasb')).toBe('F2 AE');
        expect(asmHex('lock inc word [bx]')).toBe('F0 FF 07');
    });
    it('segment overrides', () => {
        expect(asmHex('mov ax, [es:bx]')).toBe('26 8B 07');
        expect(asmHex('mov ax, es:[bx]')).toBe('26 8B 07');
        expect(asmHex('mov [cs:0x10], al')).toBe('2E A2 10 00');
    });
    it('addressing modes', () => {
        expect(asmHex('mov ax, [bx+si]')).toBe('8B 00');
        expect(asmHex('mov ax, [bp]')).toBe('8B 46 00');
        expect(asmHex('mov ax, [bp+di+2]')).toBe('8B 43 02');
        expect(asmHex('mov ax, [bx+300]')).toBe('8B 87 2C 01');
        expect(asmHex('mov ax, [si-1]')).toBe('8B 44 FF');
        expect(() => asmHex('mov ax, [bx+bp]')).toThrow(/addressing/i);
    });
});
