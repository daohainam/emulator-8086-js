// BIOS layer: IVT routing, hooks, flag returns, blocking reads, INT 10h/13h/15h/1Ah, reset state.
import { describe, it, expect } from 'vitest';
import { executeStep, VGA_BASE, ROM_BASE } from '../src/CPU8086.js';
import { PIC8259Device } from '../src/devices/PIC8259Device.js';
import { IOBus } from '../src/devices/IOBus.js';
import { resetMachine, bootFromDisk } from '../src/Machine.js';
import { BDA, rb, rw, getCursor } from '../src/bios/bda.js';
import { enqueueKey } from '../src/bios/int16.js';
import { loadProgram, makeMachine, runToStop, word } from './helpers.js';

const cell = (e, row, col) => ({ ch: e.mem[VGA_BASE + (row * 80 + col) * 2], attr: e.mem[VGA_BASE + (row * 80 + col) * 2 + 1] });
const rowText = (e, row) => {
    let s = '';
    for (let c = 0; c < 80; c++) { const ch = cell(e, row, c).ch; s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; }
    return s.trimEnd();
};

describe('reset state', () => {
    it('parks the CPU at the reset vector and idles in ROM', () => {
        const e = makeMachine();
        expect([e.reg.CS, e.reg.IP]).toEqual([0xFFFF, 0]);
        executeStep(e, {}); // JMP FAR F000:E800
        expect([e.reg.CS, e.reg.IP]).toEqual([0xF000, 0xE800]);
        expect(runToStop(e)).toBe(true); // HLT with no IRQ source: stops
    });
    it('installs a vector for every interrupt and a sane BDA', () => {
        const e = makeMachine();
        for (let v = 0; v < 256; v++) {
            const seg = word(e, v * 4 + 2);
            expect(seg, `vector ${v}`).toBe(0xF000);
        }
        expect(rw(e, BDA.EQUIPMENT)).toBe(0x0021);
        expect(rw(e, BDA.MEM_KB)).toBe(640);
        expect(rw(e, BDA.KBD_HEAD)).toBe(0x1E);
        expect(rw(e, BDA.KBD_TAIL)).toBe(0x1E);
        expect(rb(e, BDA.VIDEO_MODE)).toBe(3);
        expect(rw(e, BDA.COLUMNS)).toBe(80);
    });
    it('clears the screen to spaces with the default attribute', () => {
        const e = makeMachine();
        expect(cell(e, 0, 0)).toEqual({ ch: 0x20, attr: 0x07 });
        expect(cell(e, 24, 79)).toEqual({ ch: 0x20, attr: 0x07 });
    });
    it('ROM is write-protected for the CPU', () => {
        const { e } = loadProgram('org 100h\nmov ax,0xF000\nmov es,ax\nmov byte [es:0xFF53],0x90\nmov byte [es:0],0x55\nhlt');
        const before = e.mem[ROM_BASE + 0xFF53];
        runToStop(e);
        expect(e.mem[ROM_BASE + 0xFF53]).toBe(before);
        expect(e.mem[ROM_BASE]).toBe(0);
    });
    it('boots sector 0 of the hard disk with DL = 80h', () => {
        const e = makeMachine();
        e.disk[0] = 0xF4; e.disk[510] = 0x55; e.disk[511] = 0xAA;
        bootFromDisk(e);
        expect([e.reg.CS, e.reg.IP, e.reg.DX & 0xFF, e.reg.SP]).toEqual([0, 0x7C00, 0x80, 0x7C00]);
        expect(e.mem[0x7C00]).toBe(0xF4);
    });
});

describe('interrupt routing through the IVT', () => {
    it('a guest INT 10h hook is called and can chain to the BIOS', () => {
        const { e, asm } = loadProgram(`org 100h
            xor ax, ax
            mov es, ax
            mov ax, [es:0x40]
            mov [old_off], ax
            mov ax, [es:0x42]
            mov [old_seg], ax
            cli
            mov word [es:0x40], hook
            mov [es:0x42], cs
            sti
            mov ah, 0x0E
            mov al, 'X'
            int 0x10
            hlt
        hook:
            inc word [cs:count]
            pushf
            call far [cs:old_off]
            iret
        old_off dw 0
        old_seg dw 0
        count   dw 0`);
        expect(runToStop(e)).toBe(true);
        expect(rowText(e, 0)).toBe('X');                                  // reached the BIOS through the chain
        expect(e.mem[asm.symbolTable.get('COUNT')]).toBe(1);              // and the hook ran exactly once
    });
    it('hook counter increments (hook really ran)', () => {
        const asmSrc = `org 100h
            xor ax, ax
            mov es, ax
            mov word [es:0x40], hook
            mov [es:0x42], cs
            int 0x10
            hlt
        hook:
            inc word [cs:count]
            iret
        count dw 0`;
        const { e, asm } = loadProgram(asmSrc);
        runToStop(e);
        expect(e.mem[asm.symbolTable.get('COUNT')]).toBe(1);
    });
    it('unused vectors return immediately (dummy IRET)', () => {
        const { e } = loadProgram('org 100h\nint 0x60\nint 0x21\nmov ax, 0x1234\nhlt');
        runToStop(e);
        expect(e.reg.AX).toBe(0x1234);
        expect(e.reg.SP).toBe(0xFFFE);
    });
    it('INT n clears IF while the handler runs and the IRET restores it', () => {
        const { e } = loadProgram('org 100h\nsti\nint 0x15\nhlt');
        runToStop(e);
        expect(e.flags.IF).toBe(1);
    });
    it('unhandled hardware IRQs are acknowledged so the PIC keeps working', () => {
        const pic = new PIC8259Device();
        pic.imr = 0x00;
        const { e } = loadProgram('org 100h\nsti\nnop\nnop\nnop\nnop\nhlt');
        pic.raiseIRQ(1);
        pic.raiseIRQ(0);
        for (let i = 0; i < 40; i++) executeStep(e, { pic });
        expect(pic.isr).toBe(0);
        expect(pic.irr).toBe(0);
    });
});

describe('fatal exceptions', () => {
    it('divide error without a handler stops with a readable message', () => {
        const { e } = loadProgram('org 100h\nmov ax,5\nmov bl,0\ndiv bl\nhlt');
        expect(runToStop(e)).toBe(true);
        expect(e.fault).toMatch(/Divide error/);
    });
    it('a guest handler for INT 0 takes over', () => {
        const { e } = loadProgram(`org 100h
            xor ax, ax
            mov es, ax
            mov word [es:0], handler
            mov [es:2], cs
            mov ax, 5
            mov bl, 0
            div bl
            hlt
        handler:
            mov dx, 0xBEEF
            iret`);
        runToStop(e);
        expect(e.fault).toBeFalsy();
        expect(e.reg.DX).toBe(0xBEEF);
    });
});

describe('flag results through the stacked FLAGS', () => {
    it('INT 13h on a missing drive returns CF=1, AH=01', () => {
        const { e } = loadProgram('org 100h\nmov ah,2\nmov dl,0x55\nint 0x13\nhlt');
        runToStop(e);
        expect(e.flags.CF).toBe(1);
        expect(e.reg.AX >> 8).toBe(0x01);
    });
    it('INT 13h read success clears CF and keeps the caller flags otherwise', () => {
        const { e } = loadProgram('org 100h\nstc\nstd\nmov ah,0\nmov dl,0\nint 0x13\nhlt');
        runToStop(e);
        expect([e.flags.CF, e.flags.DF]).toEqual([0, 1]);
    });
    it('INT 16h AH=01 reports ZF for an empty / non-empty buffer', () => {
        const { e } = loadProgram('org 100h\nmov ah,1\nint 0x16\nhlt');
        runToStop(e);
        expect(e.flags.ZF).toBe(1);
        const { e: f } = loadProgram('org 100h\nmov ah,1\nint 0x16\nhlt');
        enqueueKey(f, 0x61, 0x1E);
        runToStop(f);
        expect([f.flags.ZF, f.reg.AX]).toEqual([0, 0x1E61]);
    });
});

describe('INT 16h blocking read', () => {
    it('waits (with interrupts enabled) until a key arrives, then returns it', () => {
        const { e } = loadProgram('org 100h\nmov ah,0\nint 0x16\nhlt');
        for (let i = 0; i < 50; i++) executeStep(e, {});
        expect(e.reg.AX >> 8).toBe(0);              // still waiting
        expect(e.flags.IF).toBe(1);
        enqueueKey(e, 0x41, 0x1E);
        runToStop(e);
        expect(e.reg.AX).toBe(0x1E41);
        expect(rw(e, BDA.KBD_HEAD)).toBe(rw(e, BDA.KBD_TAIL));
    });
    it('AH=05 stores a keystroke that AH=00 can read back', () => {
        const { e } = loadProgram('org 100h\nmov cx,0x1E61\nmov ah,5\nint 0x16\nmov ah,0\nint 0x16\nhlt');
        runToStop(e);
        expect(e.reg.AX).toBe(0x1E61);
    });
});

describe('INT 10h', () => {
    it('teletype keeps the attribute already on screen and advances the cursor', () => {
        const { e } = loadProgram('org 100h\nmov ah,9\nmov al,"A"\nmov bl,0x4F\nmov cx,1\nint 0x10\nmov ah,0x0E\nmov al,"B"\nint 0x10\nhlt');
        runToStop(e);
        // AH=09 wrote 'A' with attribute 4F without moving the cursor; teletype then wrote 'B' over the
        // same cell, keeping the attribute that was already there, and advanced the cursor.
        expect(cell(e, 0, 0)).toEqual({ ch: 0x42, attr: 0x4F });
        expect(getCursor(e)).toEqual({ x: 1, y: 0 });
    });
    it('teletype handles CR, LF, BS and scrolls at the bottom', () => {
        const lines = [];
        for (let i = 0; i < 26; i++) lines.push(`mov ah,0x0E\nmov al,'${String.fromCharCode(65 + (i % 26))}'\nint 0x10\nmov al,13\nint 0x10\nmov al,10\nint 0x10`);
        const { e } = loadProgram(`org 100h\n${lines.join('\n')}\nhlt`);
        runToStop(e);
        // 26 lines + CR/LF on a 25-row screen: 'A' and 'B' scrolled off, 'C' is at the top
        expect(rowText(e, 0)).toBe('C');
        expect(rowText(e, 24)).toBe('');
        expect(rowText(e, 23)).toBe('Z');
        expect(getCursor(e)).toEqual({ x: 0, y: 24 });
    });
    it('set/get cursor position (AH=02/03) round-trips through the BDA', () => {
        const { e } = loadProgram('org 100h\nmov ah,2\nmov bh,0\nmov dh,7\nmov dl,12\nint 0x10\nmov ah,3\nmov bh,0\nint 0x10\nhlt');
        runToStop(e);
        expect(e.reg.DX).toBe(0x070C);
        expect(rb(e, BDA.CURSOR)).toBe(12);
        expect(rb(e, BDA.CURSOR + 1)).toBe(7);
    });
    it('scrolling is clamped to the window and keeps BH=00 as the fill attribute', () => {
        const { e } = loadProgram('org 100h\nmov ax,0x061E\nmov bh,0\nmov cx,0x0500\nmov dx,0x0A4F\nint 0x10\nhlt');
        // pre-fill rows 0..4 and 11.. with a marker so any clobbering is visible
        for (let i = 0; i < 80 * 25; i++) { e.mem[VGA_BASE + i * 2] = 0x2E; e.mem[VGA_BASE + i * 2 + 1] = 0x07; }
        runToStop(e);
        for (let r = 0; r < 25; r++) {
            const inside = r >= 5 && r <= 10;
            expect(cell(e, r, 0), `row ${r}`).toEqual(inside ? { ch: 0x20, attr: 0x00 } : { ch: 0x2E, attr: 0x07 });
        }
        // nothing below the VGA base was touched
        expect(e.mem[VGA_BASE - 1]).toBe(0);
    });
    it('scroll up by one line moves the rows and blanks the last one', () => {
        const { e } = loadProgram('org 100h\nmov ax,0x0601\nmov bh,0x1F\nmov cx,0\nmov dx,0x184F\nint 0x10\nhlt');
        for (let c = 0; c < 80; c++) { e.mem[VGA_BASE + (1 * 80 + c) * 2] = 0x31; } // row 1 = '1...'
        runToStop(e);
        expect(cell(e, 0, 5).ch).toBe(0x31);
        expect(cell(e, 24, 0)).toEqual({ ch: 0x20, attr: 0x1F });
    });
    it('AH=0Fh reports mode 3, 80 columns, page 0', () => {
        const { e } = loadProgram('org 100h\nmov ah,0x0F\nint 0x10\nhlt');
        runToStop(e);
        expect([e.reg.AX & 0xFF, e.reg.AX >> 8, e.reg.BX >> 8]).toEqual([3, 80, 0]);
    });
    it('AH=00 sets the mode and clears the screen', () => {
        const { e } = loadProgram('org 100h\nmov ah,0x0E\nmov al,"Q"\nint 0x10\nmov ax,3\nint 0x10\nhlt');
        runToStop(e);
        expect(rowText(e, 0)).toBe('');
        expect(getCursor(e)).toEqual({ x: 0, y: 0 });
    });
    it('AH=13h writes a string', () => {
        const { e } = loadProgram(`org 100h
            push cs
            pop es
            mov bp, msg
            mov ax, 0x1301
            mov bx, 0x0007
            mov cx, 5
            mov dx, 0x0203
            int 0x10
            hlt
        msg db 'HELLO'`);
        runToStop(e);
        expect(rowText(e, 2)).toBe('   HELLO');
        expect(getCursor(e)).toEqual({ x: 8, y: 2 });
    });
});

describe('INT 11h / 12h / 15h / 1Ah', () => {
    it('INT 11h and 12h report the equipment word and memory size', () => {
        const { e } = loadProgram('org 100h\nint 0x11\nmov bx,ax\nint 0x12\nhlt');
        runToStop(e);
        expect([e.reg.BX, e.reg.AX]).toEqual([0x0021, 640]);
    });
    it('INT 15h reports unsupported functions with CF=1, AH=86h', () => {
        const { e } = loadProgram('org 100h\nmov ah,0xC0\nint 0x15\nhlt');
        runToStop(e);
        expect([e.flags.CF, e.reg.AX >> 8]).toEqual([1, 0x86]);
    });
    it('INT 15h AH=88h: no extended memory', () => {
        const { e } = loadProgram('org 100h\nmov ah,0x88\nint 0x15\nhlt');
        runToStop(e);
        expect([e.flags.CF, e.reg.AX]).toEqual([0, 0]);
    });
    it('INT 1Ah AH=00 returns a plausible tick count and AH=02/04 return BCD time/date', () => {
        const { e } = loadProgram('org 100h\nmov ah,0\nint 0x1A\nmov si,dx\nmov di,cx\nmov ah,2\nint 0x1A\nmov bx,cx\nmov ah,4\nint 0x1A\nhlt');
        runToStop(e);
        const ticks = (e.reg.DI << 16) | e.reg.SI;
        expect(ticks).toBeGreaterThanOrEqual(0);
        expect(ticks).toBeLessThan(0x1800B0);
        const hh = e.reg.BX >> 8; const mm = e.reg.BX & 0xFF;
        expect(hh & 0x0F).toBeLessThanOrEqual(9);
        expect(hh >> 4).toBeLessThanOrEqual(2);
        expect(mm >> 4).toBeLessThanOrEqual(5);
        expect(e.reg.CX >> 8).toBe(0x20); // century 20xx
    });
});

describe('resetMachine with devices', () => {
    it('resets the bus and PIC', () => {
        const bus = new IOBus();
        const pic = new PIC8259Device();
        bus.register(pic);
        pic.imr = 0x00; pic.raiseIRQ(3);
        const e = makeMachine();
        resetMachine(e, { bus });
        expect([pic.imr, pic.irr]).toEqual([0xFF, 0]);
    });
});
