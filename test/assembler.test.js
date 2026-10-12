// Assembler correctness: golden NASM encodings, forward references, CPU gating, relaxation.
import { describe, expect } from 'vitest';
import { Assembler8086 } from '../src/Assembler8086.js';
import { makeRegistrar, asmHex, assemble, assembleAndRun } from './helpers.js';

// Known-open defects (expected failures). Remove a name when the defect is fixed.
const OPEN = new Set([]);
const t = makeRegistrar(OPEN);

describe('operand size qualifiers (golden NASM bytes)', () => {
    t('mov word [bx],imm16', () => expect(asmHex('mov word [bx],0x1234')).toBe('C7 07 34 12'));
    t('mov byte [bx],imm8', () => expect(asmHex('mov byte [bx],0x12')).toBe('C6 07 12'));
    t('cmp word [bx],imm8 uses the sign-extended form', () => expect(asmHex('cmp word [bx],0')).toBe('83 3F 00'));
    t('cmp word [bx],imm16', () => expect(asmHex('cmp word [bx],300')).toBe('81 3F 2C 01'));
    t('inc word / byte [bx]', () => {
        expect(asmHex('inc word [bx]')).toBe('FF 07');
        expect(asmHex('inc byte [bx]')).toBe('FE 07');
    });
    t('dec word [bx]', () => expect(asmHex('dec word [bx]')).toBe('FF 0F'));
    t('neg / not / mul word [bx]', () => {
        expect(asmHex('neg word [bx]')).toBe('F7 1F');
        expect(asmHex('not word [bx]')).toBe('F7 17');
        expect(asmHex('mul word [bx]')).toBe('F7 27');
    });
    t('shl word / byte [bx],1', () => {
        expect(asmHex('shl word [bx],1')).toBe('D1 27');
        expect(asmHex('shl byte [bx],1')).toBe('D0 27');
    });
    t('test word [bx],imm16', () => expect(asmHex('test word [bx],0x100')).toBe('F7 07 00 01'));
    t('add word [label],1', () => expect(asmHex('x: dw 0\nadd word [x],1')).toBe('00 00 83 06 00 01 01'));
    t('or r16,imm8 assembles (size() and encode() agree)', () => expect(asmHex('or bx,5')).toBe('83 CB 05'));
    t('add r16,imm8 (guard)', () => expect(asmHex('add bx,5')).toBe('83 C3 05'));
    t('ambiguous memory operand size is an error', () => {
        expect(() => asmHex('x: dw 0\nmov [x],5')).toThrow(/size/i);
        expect(() => asmHex('x: dw 0\ninc [x]')).toThrow(/size/i);
    });
    t('register operand disambiguates the size', () => {
        expect(asmHex('mov [bx],ax')).toBe('89 07');
        expect(asmHex('mov [bx],al')).toBe('88 07');
    });
});

describe('forward references', () => {
    t('mov ax,[v] with v defined later', () => {
        const e = assembleAndRun('org 100h\nmov ax,[v]\nhlt\nv: dw 0x1234');
        expect(e.reg.AX).toBe(0x1234);
    });
    t('mov [v],ax with v defined later', () => {
        const e = assembleAndRun('org 100h\nmov ax,0x4321\nmov [v],ax\nhlt\nv: dw 0');
        expect(e.mem[0x100 + 3 + 3 + 1] | (e.mem[0x100 + 3 + 3 + 1 + 1] << 8)).toBe(0x4321);
    });
    t('label arithmetic with a forward label (mov cx,e-s)', () => {
        const e = assembleAndRun('org 100h\nmov cx, e-s\nhlt\ns: db 1,2,3\ne:');
        expect(e.reg.CX).toBe(3);
    });
    t('add ax,forward_label', () => {
        const e = assembleAndRun('org 100h\nmov ax,1\nadd ax,fwd\nhlt\nfwd:');
        expect(e.reg.AX).toBe(1 + 0x107);
    });
    t('mov word [bx],forward_label', () => expect(asmHex('mov word [bx],fwd\nfwd:')).toBe('C7 07 04 01'));
    t('data after code with [label+offset]', () => {
        const e = assembleAndRun('org 100h\nmov al,[tbl+2]\nhlt\ntbl: db 10,20,30');
        expect(e.reg.AX & 0xFF).toBe(30);
    });
    t('undefined symbol is a clear error', () => {
        expect(() => asmHex('mov ax,nowhere')).toThrow(/nowhere/i);
    });
});

describe('far control transfers', () => {
    t('jmp seg:off', () => expect(asmHex('jmp 0x1234:0x5678')).toBe('EA 78 56 34 12'));
    t('jmp far seg:off', () => expect(asmHex('jmp far 0x1234:0x5678')).toBe('EA 78 56 34 12'));
    t('call seg:off', () => expect(asmHex('call 0x1234:0x5678')).toBe('9A 78 56 34 12'));
    t('jmp 0:label (bootloader idiom)', () => expect(assemble('org 0x7C00\njmp 0:start\nstart: hlt').join(',')).toBe('234,5,124,0,0,244'));
    t('jmp far [m] / call far [m]', () => {
        expect(asmHex('jmp far [bx]')).toBe('FF 2F');
        expect(asmHex('call far [bx]')).toBe('FF 1F');
        expect(asmHex('jmp dword [bx]')).toBe('FF 2F');
    });
});

describe('unknown mnemonics and directives', () => {
    t('leave is not silently swallowed as a label on the 8086', () => {
        expect(() => asmHex('leave')).toThrow();
    });
    t('misspelled mnemonic is an error', () => {
        expect(() => asmHex('hlr')).not.toThrow(); // bare identifier = label (NASM allows it)
        expect(() => asmHex('movv ax,1')).toThrow();
    });
    t('salc / int3', () => {
        expect(asmHex('salc')).toBe('D6');
        expect(asmHex('int3')).toBe('CC');
    });
    t('unsupported % directive is an error', () => {
        expect(() => asmHex('%macro foo 0\nnop\n%endmacro\nfoo')).toThrow();
    });
    t('%define still works', () => expect(asmHex('%define VAL 7\nmov al,VAL')).toBe('B0 07'));
});

describe('CPU gating (strict 8086 + opt-in 186)', () => {
    t('default cpu is 8086, directive switches to 186', () => {
        const a = new Assembler8086(); a.assemble('nop');
        expect(a.cpu).toBe('8086');
        const b = new Assembler8086(); b.assemble('cpu 186\nnop');
        expect(b.cpu).toBe('186');
        const c = new Assembler8086(); c.assemble('nop', { cpu: '186' });
        expect(c.cpu).toBe('186');
    });
    t('186 instructions are rejected on the 8086', () => {
        for (const src of ['shl ax,4', 'push 5', 'pusha', 'popa', 'insb', 'outsb', 'imul ax,bx,3', 'enter 4,0', 'bound ax,[bx]', 'leave']) {
            expect(() => asmHex(src), src).toThrow();
        }
    });
    t('186 instructions encode with cpu 186', () => {
        expect(asmHex('cpu 186\nshl ax,4')).toBe('C1 E0 04');
        expect(asmHex('cpu 186\nshl byte [bx],3')).toBe('C0 27 03');
        expect(asmHex('cpu 186\npush 5')).toBe('6A 05');
        expect(asmHex('cpu 186\npush 0x1234')).toBe('68 34 12');
        expect(asmHex('cpu 186\npusha')).toBe('60');
        expect(asmHex('cpu 186\npopa')).toBe('61');
        expect(asmHex('cpu 186\ninsb')).toBe('6C');
        expect(asmHex('cpu 186\noutsw')).toBe('6F');
        expect(asmHex('cpu 186\nimul ax,bx,3')).toBe('6B C3 03');
        expect(asmHex('cpu 186\nenter 4,0')).toBe('C8 04 00 00');
        expect(asmHex('cpu 186\nleave')).toBe('C9');
        expect(asmHex('cpu 186\nbound ax,[bx]')).toBe('62 07');
    });
    t('shl by 1 / CL still works on the 8086', () => {
        expect(asmHex('shl ax,1')).toBe('D1 E0');
        expect(asmHex('shl ax,cl')).toBe('D3 E0');
    });
});

describe('additional forms', () => {
    t('aam / aad with and without immediate', () => {
        expect(asmHex('aam')).toBe('D4 0A');
        expect(asmHex('aam 16')).toBe('D4 10');
        expect(asmHex('aad')).toBe('D5 0A');
        expect(asmHex('aad 16')).toBe('D5 10');
    });
    t('test r,[m]', () => {
        expect(asmHex('test al,[bx]')).toBe('84 07');
        expect(asmHex('test ax,[bx]')).toBe('85 07');
    });
    t('short accumulator<->moffs MOV forms (NASM parity)', () => {
        expect(asmHex('mov al,[0x200]')).toBe('A0 00 02');
        expect(asmHex('mov ax,[0x200]')).toBe('A1 00 02');
        expect(asmHex('mov [0x200],al')).toBe('A2 00 02');
        expect(asmHex('mov [0x200],ax')).toBe('A3 00 02');
        expect(asmHex('mov al,[es:0x200]')).toBe('26 A0 00 02');
    });
    t('out-of-range immediates produce warnings', () => {
        const a = new Assembler8086();
        a.assemble('mov al,300');
        expect(a.warnings.length).toBeGreaterThan(0);
        const b = new Assembler8086();
        b.assemble('mov al,255\nmov al,-128\nmov ax,0xFFFF');
        expect(b.warnings).toEqual([]);
    });
});

describe('layout and jump relaxation', () => {
    t('boot sector padding with times / $$', () => {
        const bin = assemble('org 0x7C00\nnop\ntimes 510-($-$$) db 0\ndw 0xAA55');
        expect(bin.length).toBe(512);
        expect([bin[510], bin[511]]).toEqual([0x55, 0xAA]);
    });
    t('equ with $ - label', () => {
        const e = assembleAndRun('org 100h\nmov cx,len\nhlt\nmsg: db "hello"\nlen equ $ - msg');
        expect(e.reg.CX).toBe(5);
    });
    t('short jump becomes near when out of range', () => {
        const bin = assemble('org 100h\njmp end\ntimes 200 nop\nend: hlt');
        expect(bin[0]).toBe(0xE9);
    });
    t('many long forward jumps relax to a fix-point', () => {
        let src = 'org 100h\n';
        for (let i = 0; i < 12; i++) src += `jmp L${i}\n`;
        src += 'times 200 nop\n';
        for (let i = 0; i < 12; i++) src += `L${i}: nop\n`;
        const bin = assemble(src);
        expect(bin[0]).toBe(0xE9);
        expect(bin.length).toBe(12 * 3 + 200 + 12);
    });
    t('conditional jump out of range is still an error', () => {
        expect(() => assemble('org 100h\njz far_away\ntimes 200 nop\nfar_away: hlt')).toThrow(/range/i);
    });
    t('local labels are scoped to the previous global label', () => {
        const e = assembleAndRun('org 100h\nfirst:\nmov cx,2\n.l: loop .l\nsecond:\nmov bx,3\n.l: dec bx\njnz .l\nhlt');
        expect([e.reg.CX, e.reg.BX]).toEqual([0, 0]);
    });
});

describe('size/encode consistency sweep', () => {
    t('no rule reports a size different from what it encodes', () => {
        const alu = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
        const aluOps = ['al,bl', 'ax,bx', 'al,5', 'ax,5', 'bl,5', 'bx,5', 'bx,-5', 'bx,300', 'al,[bx]', 'ax,[bx]', 'bx,[bx+2]', 'bx,[bx+300]',
            '[bx],al', '[bx],ax', '[bx+2],bx', 'byte [bx],5', 'word [bx],5', 'word [bx],-5', 'word [bx],300', 'word [bx+2],5', 'byte [bp],5'];
        const unary = ['inc', 'dec', 'neg', 'not', 'mul', 'imul', 'div', 'idiv'];
        const unaryOps = ['al', 'ax', 'bl', 'bx', 'byte [bx]', 'word [bx]', 'word [bp+2]'];
        const shifts = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'sal', 'shr', 'sar'];
        const shiftOps = ['al,1', 'ax,1', 'al,cl', 'ax,cl', 'byte [bx],1', 'word [bx],1', 'word [bx],cl', 'byte [bx+2],cl'];
        const misc = ['test al,bl', 'test ax,bx', 'test al,5', 'test ax,5', 'test bx,5', 'test byte [bx],5', 'test word [bx],5', 'test [bx],al',
            'mov al,bl', 'mov ax,bx', 'mov al,5', 'mov ax,5', 'mov bx,300', 'mov al,[bx]', 'mov ax,[bx]', 'mov [bx],al', 'mov [bx],ax',
            'mov byte [bx],5', 'mov word [bx],5', 'mov word [bx+2],300', 'mov ds,ax', 'mov ax,ds', 'mov ds,[bx]', 'mov [bx],ds',
            'xchg ax,bx', 'xchg bx,cx', 'xchg al,bl', 'xchg [bx],ax', 'xchg al,[bx]', 'lea ax,[bx+si+2]', 'lds si,[bx]', 'les di,[bx]',
            'push ax', 'push ds', 'push word [bx]', 'pop ax', 'pop es', 'pop word [bx]', 'in al,0x60', 'in ax,dx', 'out 0x61,al', 'out dx,ax',
            'ret', 'ret 4', 'retf', 'retf 2', 'int 3', 'int 0x21', 'call [bx]', 'call ax', 'jmp ax', 'jmp [bx]'];
        const lines = [];
        for (const m of alu) for (const o of aluOps) lines.push(`${m} ${o}`);
        for (const m of unary) for (const o of unaryOps) lines.push(`${m} ${o}`);
        for (const m of shifts) for (const o of shiftOps) lines.push(`${m} ${o}`);
        lines.push(...misc);
        const mismatches = [];
        for (const line of lines) {
            try { assemble(`org 100h\n${line}`); }
            catch (err) { if (/size mismatch/i.test(err.message)) mismatches.push(line); }
        }
        expect(mismatches).toEqual([]);
    });
});
