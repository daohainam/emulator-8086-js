// ==========================================
// CPU8086 — Intel 8086 Processor Emulation
// ==========================================

// --- HARDWARE CONSTANTS ---
const ADDR_SPACE     = 1048576; // Total address space (1 MB)
const DISK_SIZE      = 131072;  // Virtual disk size (128 KB)
const SECTOR_SIZE    = 512;     // Standard disk sector size

const FLOPPY_SIZE    = 1474560; // 3.5" 1.44 MB floppy image (2880 sectors × 512 bytes); geometry lives in bios/int13.js

const VGA_BASE       = 0xB8000; // VGA text mode VRAM base address
const VGA_COLS       = 80;      // VGA text mode columns
const VGA_ROWS       = 25;      // VGA text mode rows
const VGA_SIZE       = VGA_COLS * VGA_ROWS * 2; // 4000 Bytes

const toHex = (n, pad = 4) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(pad, '0');
const calcPhys = (s, o) => (((s & 0xFFFF) << 4) + (o & 0xFFFF)) & (ADDR_SPACE - 1);

const PARITY_TABLE = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let p = 1, x = i;
        while (x) { p ^= 1; x &= x - 1; }
        t[i] = p;
    }
    return t;
})();
const calcParity = (val) => PARITY_TABLE[val & 0xFF];

// ===============================================
// CORE: MEMORY MANAGER
// ===============================================
// The BIOS ROM occupies F000:0000-FFFF. Guest (CPU) writes there are ignored like on real ROM;
// host-side loads and edits use writeMem8Safe, which bypasses the protection.
const ROM_BASE = 0xF0000;

const readMem8 = (e, phys) => e.mem[phys];
const writeMem8 = (e, phys, val) => { if (phys < ROM_BASE) e.mem[phys] = val & 0xFF; };
const writeMem8Safe = (e, phys, val) => { if (phys < ADDR_SPACE) e.mem[phys] = val & 0xFF; };

// Word access by physical address (IVT, BDA, host-side code). The high byte wraps at the 1 MB boundary.
const readMemWord = (e, phys) => readMem8(e, phys) | (readMem8(e, (phys + 1) & (ADDR_SPACE - 1)) << 8);
const writeMemWord = (e, phys, val) => { writeMem8(e, phys, val & 0xFF); writeMem8(e, (phys + 1) & (ADDR_SPACE - 1), (val >> 8) & 0xFF); };

// Word access by segment:offset. The high byte lives at offset+1 *inside the same segment* (wraps at 64 KB).
const readWordSeg = (e, seg, off) => readMem8(e, calcPhys(seg, off)) | (readMem8(e, calcPhys(seg, off + 1)) << 8);
const writeWordSeg = (e, seg, off, val) => { writeMem8(e, calcPhys(seg, off), val & 0xFF); writeMem8(e, calcPhys(seg, off + 1), (val >> 8) & 0xFF); };

const push16 = (e, val) => { e.reg.SP = (e.reg.SP - 2) & 0xFFFF; writeWordSeg(e, e.reg.SS, e.reg.SP, val); };
const pop16 = (e) => { const val = readWordSeg(e, e.reg.SS, e.reg.SP); e.reg.SP = (e.reg.SP + 2) & 0xFFFF; return val; };

// FLAGS image as seen by PUSHF on an 8086/80186: bit 1 and bits 12-15 always read as 1.
const FLAGS_FIXED_BITS = 0xF002;
const packFlags = (e) => {
    const f = e.flags; let r = FLAGS_FIXED_BITS;
    if (f.CF) r |= (1<<0); if (f.PF) r |= (1<<2); if (f.AF) r |= (1<<4);
    if (f.ZF) r |= (1<<6); if (f.SF) r |= (1<<7); if (f.TF) r |= (1<<8); if (f.IF) r |= (1<<9);
    if (f.DF) r |= (1<<10); if (f.OF) r |= (1<<11);
    return r;
};
const unpackFlags = (e, r) => {
    const f = e.flags;
    f.CF = (r & (1<<0)) ? 1 : 0; f.PF = (r & (1<<2)) ? 1 : 0; f.AF = (r & (1<<4)) ? 1 : 0;
    f.ZF = (r & (1<<6)) ? 1 : 0; f.SF = (r & (1<<7)) ? 1 : 0; f.TF = (r & (1<<8)) ? 1 : 0; f.IF = (r & (1<<9)) ? 1 : 0;
    f.DF = (r & (1<<10)) ? 1 : 0; f.OF = (r & (1<<11)) ? 1 : 0;
};

/**
 * Fresh CPU engine state. `cpuModel` selects the instruction set: '8086' (strict, default) or '186' (opt-in).
 *  - halted:     CPU is idle after HLT, waiting for an interrupt
 *  - inhibitIRQ: set by STI / MOV SS / POP SS; suppresses IRQ delivery after the *next* step only
 *  - hle:        host callbacks (index -> fn(e, ctx)) invoked by the BIOS stubs
 */
const createEngine = (over = {}) => ({
    reg: { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, SP: 0xFFFE, BP: 0, CS: 0, DS: 0, SS: 0, ES: 0, IP: 0 },
    flags: { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0, TF: 0 },
    mem: new Uint8Array(ADDR_SPACE),
    disk: new Uint8Array(DISK_SIZE),
    floppy: new Uint8Array(FLOPPY_SIZE),
    cursorX: 0,
    cursorY: 0,
    cpuModel: '8086',
    halted: false,
    inhibitIRQ: false,
    hle: [],
    ...over,
});

// AF (auxiliary/half-carry) flag — set when carry/borrow crosses the low nibble.
const computeAF = (dst, src, res) => ((dst ^ src ^ res) & 0x10) ? 1 : 0;

// Compute one 8086 ALU operation and the resulting flag set.
// op: 0=ADD 1=OR 2=ADC 3=SBB 4=AND 5=SUB 6=XOR 7=CMP
const aluCompute = (op, dst, src, isWord, cfIn) => {
    const mask = isWord ? 0xFFFF : 0xFF;
    const signBit = isWord ? 0x8000 : 0x80;
    let raw, CF = 0, OF = 0, AF = 0;
    if (op === 0)        { raw = dst + src;             CF = raw > mask ? 1 : 0; OF = ((dst ^ raw) & (src ^ raw) & signBit) ? 1 : 0; AF = computeAF(dst, src, raw); }
    else if (op === 1)   { raw = dst | src; }
    else if (op === 2)   { raw = dst + src + cfIn;      CF = raw > mask ? 1 : 0; OF = ((dst ^ raw) & (src ^ raw) & signBit) ? 1 : 0; AF = computeAF(dst, src, raw); }
    else if (op === 3)   { raw = dst - src - cfIn;      CF = dst < (src + cfIn) ? 1 : 0; OF = ((dst ^ src) & (dst ^ raw) & signBit) ? 1 : 0; AF = computeAF(dst, src, raw); }
    else if (op === 4)   { raw = dst & src; }
    else if (op === 5 || op === 7) { raw = dst - src;   CF = dst < src ? 1 : 0; OF = ((dst ^ src) & (dst ^ raw) & signBit) ? 1 : 0; AF = computeAF(dst, src, raw); }
    else                 { raw = dst ^ src; }
    const res = raw & mask;
    return { res, write: op !== 7, CF, OF, AF, ZF: res === 0 ? 1 : 0, SF: (res & signBit) ? 1 : 0, PF: PARITY_TABLE[res & 0xFF] };
};

// Apply an ALU result's flag set to engine flags.
const applyAluFlags = (e, r) => {
    e.flags.CF = r.CF; e.flags.OF = r.OF; e.flags.AF = r.AF;
    e.flags.ZF = r.ZF; e.flags.SF = r.SF; e.flags.PF = r.PF;
};

// Raise a CPU interrupt: push flags, clear IF and TF, push CS:IP, jump through IVT[vector].
const raiseInt = (e, vector) => {
    push16(e, packFlags(e));
    e.flags.IF = 0;
    e.flags.TF = 0;
    push16(e, e.reg.CS);
    push16(e, e.reg.IP);
    e.reg.IP = readMemWord(e, calcPhys(0, vector * 4));
    e.reg.CS = readMemWord(e, calcPhys(0, vector * 4 + 2));
};

// ===============================================
// ENGINE: TRUE HARDWARE X86 DECODER
// ===============================================

/**
 * Decode and execute one x86 opcode.
 * @param {object} e - CPU engine state (eng.current)
 * @param {object} ctx - External context: { bus, keyboard, shiftState, pic }
 * @returns {boolean} true to continue, false to halt
 */
const SEG_REG_NAMES = ["ES", "CS", "SS", "DS"];
const PREFIX_OPS = new Set([0x26, 0x2E, 0x36, 0x3E, 0xF0, 0xF2, 0xF3]);

const executeBinaryStep = (e, ctx) => {
    const is186 = e.cpuModel === '186';
    const opIP = e.reg.IP;

    const fetch8 = () => {
        const v = readMem8(e, calcPhys(e.reg.CS, e.reg.IP));
        e.reg.IP = (e.reg.IP + 1) & 0xFFFF;
        return v;
    };
    const fetch16 = () => { const lo = fetch8(); const hi = fetch8(); return (hi << 8) | lo; };
    
    const getReg16 = (idx) => e.reg[["AX","CX","DX","BX","SP","BP","SI","DI"][idx]];
    const setReg16 = (idx, val) => e.reg[["AX","CX","DX","BX","SP","BP","SI","DI"][idx]] = val & 0xFFFF;
    const getReg8 = (idx) => {
        const r = ["AX","CX","DX","BX"][idx % 4];
        return idx < 4 ? e.reg[r] & 0xFF : (e.reg[r] >> 8) & 0xFF;
    };
    const setReg8 = (idx, val) => {
        const r = ["AX","CX","DX","BX"][idx % 4];
        if (idx < 4) e.reg[r] = (e.reg[r] & 0xFF00) | (val & 0xFF);
        else e.reg[r] = (e.reg[r] & 0x00FF) | ((val & 0xFF) << 8);
    };
    
    let segOv = null;
    let repPrefix = 0;
    let op = fetch8();
    // 0xF0 (LOCK) is consumed but has no semantic effect in single-CPU emulation.
    // On the 8086 0xF1 is an undocumented alias of LOCK.
    while (PREFIX_OPS.has(op) || (op === 0xF1 && !is186)) {
        if (op===0x26) segOv=e.reg.ES; if (op===0x2E) segOv=e.reg.CS;
        if (op===0x36) segOv=e.reg.SS; if (op===0x3E) segOv=e.reg.DS;
        if (op===0xF2 || op===0xF3) repPrefix = op;
        op = fetch8();
    }

    // Undocumented 8086 aliases: the 186 decodes these opcodes as real instructions,
    // the 8086 shares the decode logic with their neighbours.
    if (!is186) {
        if (op >= 0x60 && op <= 0x6F) op += 0x10;                                      // 60-6F -> Jcc 70-7F
        else if (op === 0xC0 || op === 0xC1 || op === 0xC8 || op === 0xC9) op += 2;    // -> RET / RETF
    }

    // Decode a ModRM byte (plus displacement). Memory operands are returned as seg:ea so word
    // accesses can wrap inside the segment; register operands have mod === 3.
    const modrmDec = () => {
        const b = fetch8();
        const mod = b>>6; const reg = (b>>3)&7; const rm = b&7;
        let seg = e.reg.DS;
        let ea = 0;
        if (mod !== 3) {
            if(rm===0)ea=e.reg.BX+e.reg.SI; else if(rm===1)ea=e.reg.BX+e.reg.DI;
            else if(rm===2){ea=e.reg.BP+e.reg.SI;seg=e.reg.SS;} else if(rm===3){ea=e.reg.BP+e.reg.DI;seg=e.reg.SS;}
            else if(rm===4)ea=e.reg.SI; else if(rm===5)ea=e.reg.DI;
            else if(rm===6){if(mod===0)ea=fetch16();else{ea=e.reg.BP;seg=e.reg.SS;}}
            else if(rm===7)ea=e.reg.BX;
            if(mod===1)ea+=(fetch8()<<24>>24); else if(mod===2)ea+=fetch16();
            ea = ea & 0xFFFF;
            if (segOv !== null) seg = segOv;
        }
        return {mod, reg, rm, seg, ea};
    };
    const rmRd = (m, w) => m.mod===3 ? (w?getReg16(m.rm):getReg8(m.rm)) : (w?readWordSeg(e, m.seg, m.ea):readMem8(e, calcPhys(m.seg, m.ea)));
    const rmWr = (m, w, v) => { if(m.mod===3) {if(w)setReg16(m.rm,v);else setReg8(m.rm,v);} else {if(w)writeWordSeg(e, m.seg, m.ea, v);else writeMem8(e, calcPhys(m.seg, m.ea), v);} };
    // Undefined encoding: the 186 raises INT 6 at the faulting instruction; the 8086 has no such trap.
    const undefinedOp = () => { if (is186) { e.reg.IP = opIP; raiseInt(e, 6); } return true; };

    const updFlags = (r, isWord) => {
        e.flags.ZF = (r & (isWord?0xFFFF:0xFF)) === 0 ? 1 : 0;
        e.flags.SF = (r & (isWord?0x8000:0x80)) ? 1 : 0;
    };

    if (op === 0x90) return true;       // NOP
    if (op === 0x9B) return true;       // WAIT — no FPU, treat as NOP
    if (op === 0xF4) {                  // HLT
        // Idle until an interrupt when one can actually arrive; otherwise nothing can wake the CPU, so stop.
        const pic = ctx && ctx.pic;
        const canWake = e.flags.IF && pic && ((~pic.imr) & 0xFF) !== 0;
        if (!canWake) return false;
        e.halted = true;
        return true;
    }

    // INT 3 (one-byte breakpoint) and INTO (interrupt-if-overflow) — raise IVT-dispatched interrupts.
    if (op === 0xCC) { raiseInt(e, 3); return true; }
    if (op === 0xCE) { if (e.flags.OF) raiseInt(e, 4); return true; }
    
    if (op === 0xFA) { e.flags.IF = 0; return true; } // CLI
    if (op === 0xFB) { e.flags.IF = 1; e.inhibitIRQ = true; return true; } // STI — IRQs are recognised after the next instruction
    if (op === 0xF8) { e.flags.CF = 0; return true; } // CLC
    if (op === 0xF9) { e.flags.CF = 1; return true; } // STC
    if (op === 0xFC) { e.flags.DF = 0; return true; } // CLD
    if (op === 0xFD) { e.flags.DF = 1; return true; } // STD
    if (op === 0xF5) { e.flags.CF = 1 - e.flags.CF; return true; } // CMC
    
    if (op >= 0xB8 && op <= 0xBF) { setReg16(op-0xB8, fetch16()); return true; } // MOV r16, imm16
    if (op >= 0xB0 && op <= 0xB7) { setReg8(op-0xB0, fetch8()); return true; } // MOV r8, imm8
    
    if (op === 0x8E) { // MOV Sreg, r/m — the reg field's top bit is ignored; loading SS delays IRQs by one instruction
        const m = modrmDec(); const sr = SEG_REG_NAMES[m.reg & 3];
        e.reg[sr] = rmRd(m, true);
        if (sr === "SS") e.inhibitIRQ = true;
        return true;
    }
    if (op === 0x8C) { const m = modrmDec(); rmWr(m, true, e.reg[SEG_REG_NAMES[m.reg & 3]]); return true; } // MOV r/m, Sreg
    if (op === 0x8B) { const m = modrmDec(); setReg16(m.reg, rmRd(m, true)); return true; } // MOV r16, r/m16
    if (op === 0x8A) { const m = modrmDec(); setReg8(m.reg, rmRd(m, false)); return true; } // MOV r8, r/m8
    if (op === 0x89) { const m = modrmDec(); rmWr(m, true, getReg16(m.reg)); return true; } // MOV r/m16, r16
    if (op === 0x88) { const m = modrmDec(); rmWr(m, false, getReg8(m.reg)); return true; } // MOV r/m8, r8
    if (op === 0xC7) { const m = modrmDec(); rmWr(m, true, fetch16()); return true; } // MOV r/m16, imm16
    if (op === 0xC6) { const m = modrmDec(); rmWr(m, false, fetch8()); return true; } // MOV r/m8, imm8
    if (op === 0xC4 || op === 0xC5) { // LES / LDS — the register form is undefined
        const m = modrmDec();
        if (m.mod === 3) return undefinedOp();
        const off = readWordSeg(e, m.seg, m.ea); const seg = readWordSeg(e, m.seg, (m.ea + 2) & 0xFFFF);
        setReg16(m.reg, off);
        if (op === 0xC4) e.reg.ES = seg; else e.reg.DS = seg;
        return true;
    }
    if (op === 0x8F) { // POP r/m16 (only /0 is defined; other encodings just consume the operand)
        const m = modrmDec();
        if (m.reg === 0) rmWr(m, true, pop16(e));
        return true;
    }
    if (op === 0xA0 || op === 0xA1 || op === 0xA2 || op === 0xA3) { // MOV AL/AX <-> [moffs16]
        const off = fetch16(); const seg = segOv !== null ? segOv : e.reg.DS;
        if (op === 0xA0) setReg8(0, readMem8(e, calcPhys(seg, off)));
        else if (op === 0xA1) setReg16(0, readWordSeg(e, seg, off));
        else if (op === 0xA2) writeMem8(e, calcPhys(seg, off), getReg8(0));
        else writeWordSeg(e, seg, off, getReg16(0));
        return true;
    }
    if (op === 0xD6 && !is186) { setReg8(0, e.flags.CF ? 0xFF : 0x00); return true; } // SALC (undocumented on the 8086)
    if (op >= 0xD8 && op <= 0xDF) { modrmDec(); return true; } // ESC — no coprocessor: consume the operand, do nothing
    if (op === 0x0F && !is186) { e.reg.CS = pop16(e); return true; } // POP CS (8086 only)

    // INC/DEC preserve CF; set OF/AF/SF/ZF/PF.
    if (op >= 0x40 && op <= 0x47) { const r=op-0x40; const orig=getReg16(r); const v=(orig+1)&0xFFFF; setReg16(r,v); updFlags(v,true); e.flags.OF=orig===0x7FFF?1:0; e.flags.AF=computeAF(orig,1,orig+1); e.flags.PF=calcParity(v); return true; } // INC r16
    if (op >= 0x48 && op <= 0x4F) { const r=op-0x48; const orig=getReg16(r); const v=(orig-1)&0xFFFF; setReg16(r,v); updFlags(v,true); e.flags.OF=orig===0x8000?1:0; e.flags.AF=computeAF(orig,1,orig-1); e.flags.PF=calcParity(v); return true; } // DEC r16
    if (op === 0xFE) {
        // Host callback used by the BIOS stubs: FE 38 <id>. (FE /7 is undefined on the 8086.)
        if (readMem8(e, calcPhys(e.reg.CS, e.reg.IP)) === 0x38) {
            fetch8();
            const id = fetch8();
            const service = e.hle[id];
            if (!service) return undefinedOp();
            const outcome = service(e, ctx);
            if (outcome === 'stop') return false;
            if (outcome === 'retry') { // blocking service: run the stub again, with interrupts enabled so IRQs can arrive
                e.reg.IP = opIP;
                e.flags.IF = 1;
                return true;
            }
            // Hand CF/ZF results back through the stacked FLAGS (the stub's IRET restores the rest).
            const flagsAt = calcPhys(e.reg.SS, e.reg.SP + 4);
            const stacked = readMemWord(e, flagsAt);
            writeMemWord(e, flagsAt, (stacked & ~0x0041) | (e.flags.CF ? 0x0001 : 0) | (e.flags.ZF ? 0x0040 : 0));
            return true;
        }
        const m=modrmDec(); const orig=rmRd(m,false);
        if (m.reg===0) { const res=orig+1; rmWr(m,false,res); updFlags(res,false); e.flags.OF=orig===0x7F?1:0; e.flags.AF=computeAF(orig,1,res); e.flags.PF=calcParity(res); }
        else if (m.reg===1) { const res=orig-1; rmWr(m,false,res); updFlags(res,false); e.flags.OF=orig===0x80?1:0; e.flags.AF=computeAF(orig,1,res); e.flags.PF=calcParity(res); }
        return true;
    }
    if (op === 0xFF) {
        const m=modrmDec();
        if(m.reg===0) { const orig=rmRd(m,true); const res=orig+1; rmWr(m,true,res); updFlags(res,true); e.flags.OF=orig===0x7FFF?1:0; e.flags.AF=computeAF(orig,1,res); e.flags.PF=calcParity(res); }
        else if(m.reg===1) { const orig=rmRd(m,true); const res=orig-1; rmWr(m,true,res); updFlags(res,true); e.flags.OF=orig===0x8000?1:0; e.flags.AF=computeAF(orig,1,res); e.flags.PF=calcParity(res); }
        else if(m.reg===2||m.reg===4){ const target=rmRd(m,true); if(m.reg===2) push16(e, e.reg.IP); e.reg.IP=target; } // CALL/JMP near r/m — operand is read before the push
        else if(m.reg===3||m.reg===5){ // CALL/JMP far [m] — the register form is undefined and ignored
            if (m.mod!==3) {
                const off=readWordSeg(e, m.seg, m.ea); const seg=readWordSeg(e, m.seg, (m.ea+2)&0xFFFF);
                if(m.reg===3){ push16(e, e.reg.CS); push16(e, e.reg.IP); }
                e.reg.IP=off; e.reg.CS=seg;
            }
        }
        else if(m.reg===6||m.reg===7) push16(e, rmRd(m,true)); // /7 is an undocumented alias of PUSH on the 8086
        return true;
    }

    // PUSH r16 — PUSH SP stores the already-decremented SP on the 8086 (the 186 stores the original value).
    if (op >= 0x50 && op <= 0x57) { push16(e, (op === 0x54 && !is186) ? (e.reg.SP - 2) & 0xFFFF : getReg16(op-0x50)); return true; }
    if (op >= 0x58 && op <= 0x5F) { setReg16(op-0x58, pop16(e)); return true; } // POP r16
    if (op === 0x06) { push16(e, e.reg.ES); return true; } // PUSH ES
    if (op === 0x07) { e.reg.ES = pop16(e); return true; } // POP ES
    if (op === 0x0E) { push16(e, e.reg.CS); return true; } // PUSH CS
    if (op === 0x16) { push16(e, e.reg.SS); return true; } // PUSH SS
    if (op === 0x17) { e.reg.SS = pop16(e); e.inhibitIRQ = true; return true; } // POP SS — IRQs are recognised after the next instruction
    if (op === 0x1E) { push16(e, e.reg.DS); return true; } // PUSH DS
    if (op === 0x1F) { e.reg.DS = pop16(e); return true; } // POP DS
    if (op === 0x60) { const sp = e.reg.SP; push16(e, e.reg.AX); push16(e, e.reg.CX); push16(e, e.reg.DX); push16(e, e.reg.BX); push16(e, sp); push16(e, e.reg.BP); push16(e, e.reg.SI); push16(e, e.reg.DI); return true; } // PUSHA
    if (op === 0x61) { e.reg.DI = pop16(e); e.reg.SI = pop16(e); e.reg.BP = pop16(e); pop16(e); e.reg.BX = pop16(e); e.reg.DX = pop16(e); e.reg.CX = pop16(e); e.reg.AX = pop16(e); return true; } // POPA
    if (op === 0xC9) { e.reg.SP = e.reg.BP; e.reg.BP = pop16(e); return true; } // LEAVE

    // 80186 additions. On the 8086 these opcodes were remapped to their aliases above (or are undefined).
    if (is186) {
        if (op === 0x68) { push16(e, fetch16()); return true; }                          // PUSH imm16
        if (op === 0x6A) { push16(e, (fetch8() << 24 >> 24) & 0xFFFF); return true; }     // PUSH imm8 (sign-extended)
        if (op === 0x69 || op === 0x6B) { // IMUL r16, r/m16, imm16 / imm8
            const m = modrmDec(); const src = rmRd(m, true);
            const imm = op === 0x69 ? fetch16() : (fetch8() << 24 >> 24);
            const prod = ((src << 16) >> 16) * ((imm << 16) >> 16);
            setReg16(m.reg, prod & 0xFFFF);
            e.flags.CF = e.flags.OF = (prod < -32768 || prod > 32767) ? 1 : 0;
            return true;
        }
        if (op === 0x62) { // BOUND r16, m16:16 — INT 5 when the index is outside [lower, upper]
            const m = modrmDec();
            if (m.mod === 3) return undefinedOp();
            const lo = (readWordSeg(e, m.seg, m.ea) << 16) >> 16;
            const hi = (readWordSeg(e, m.seg, (m.ea + 2) & 0xFFFF) << 16) >> 16;
            const idx = (getReg16(m.reg) << 16) >> 16;
            if (idx < lo || idx > hi) { e.reg.IP = opIP; raiseInt(e, 5); }
            return true;
        }
        if (op === 0xC8) { // ENTER size, level
            const size = fetch16(); const level = fetch8() & 0x1F;
            push16(e, e.reg.BP);
            const frame = e.reg.SP;
            if (level > 0) {
                for (let i = 1; i < level; i++) { e.reg.BP = (e.reg.BP - 2) & 0xFFFF; push16(e, readWordSeg(e, e.reg.SS, e.reg.BP)); }
                push16(e, frame);
            }
            e.reg.BP = frame;
            e.reg.SP = (e.reg.SP - size) & 0xFFFF;
            return true;
        }
    }

    const isALUModRM = (op >= 0x00 && op <= 0x03) || (op >= 0x08 && op <= 0x0B) ||
                       (op >= 0x10 && op <= 0x13) || (op >= 0x18 && op <= 0x1B) ||
                       (op >= 0x20 && op <= 0x23) || (op >= 0x28 && op <= 0x2B) ||
                       (op >= 0x30 && op <= 0x33) || (op >= 0x38 && op <= 0x3B);
    if (isALUModRM) {
        const aluOp = (op >> 3) & 7;
        const isWord = (op & 1) === 1;
        const dir = (op & 2) !== 0;
        const m = modrmDec();
        const rmVal = rmRd(m, isWord);
        const regVal = isWord ? getReg16(m.reg) : getReg8(m.reg);
        const dst = dir ? regVal : rmVal;
        const src = dir ? rmVal : regVal;

        const r = aluCompute(aluOp, dst, src, isWord, e.flags.CF);
        applyAluFlags(e, r);
        if (r.write) {
            if (dir) { if (isWord) setReg16(m.reg, r.res); else setReg8(m.reg, r.res); }
            else rmWr(m, isWord, r.res);
        }
        return true;
    }

    const isALUAcc = (op & 0xC6) === 0x04;
    if (isALUAcc) {
        const aluOp = (op >> 3) & 7;
        const isWord = (op & 1) === 1;
        const imm = isWord ? fetch16() : fetch8();
        const dst = isWord ? getReg16(0) : getReg8(0);

        const r = aluCompute(aluOp, dst, imm, isWord, e.flags.CF);
        applyAluFlags(e, r);
        if (r.write) { if (isWord) setReg16(0, r.res); else setReg8(0, r.res); }
        return true;
    }

    if (op >= 0x80 && op <= 0x83) {
        const isWord = op === 0x81 || op === 0x83;
        const m = modrmDec();
        let imm = fetch8();
        if (op === 0x81) { const hi = fetch8(); imm = (hi << 8) | imm; }
        else if (op === 0x83) imm = (imm << 24 >> 24) & (isWord ? 0xFFFF : 0xFF); // sign-extend then mask to operand width
        const dst = rmRd(m, isWord);
        const aluOp = m.reg;

        const r = aluCompute(aluOp, dst, imm, isWord, e.flags.CF);
        applyAluFlags(e, r);
        if (r.write) rmWr(m, isWord, r.res);
        return true;
    }

    if (op === 0x84 || op === 0x85) {
        const isWord = op === 0x85;
        const m = modrmDec();
        const v1 = rmRd(m, isWord);
        const v2 = isWord ? getReg16(m.reg) : getReg8(m.reg);
        const res = v1 & v2;
        updFlags(res, isWord); e.flags.CF = 0; e.flags.OF = 0; e.flags.PF = calcParity(res);
        return true;
    }
    
    if (op === 0x8D) {
        const m = modrmDec();
        setReg16(m.reg, m.ea);
        return true;
    }

    if (op === 0x86 || op === 0x87) {
        const isWord = op === 0x87;
        const m = modrmDec();
        const v1 = rmRd(m, isWord);
        const v2 = isWord ? getReg16(m.reg) : getReg8(m.reg);
        rmWr(m, isWord, v2);
        if (isWord) setReg16(m.reg, v1); else setReg8(m.reg, v1);
        return true;
    }

    if (op >= 0x91 && op <= 0x97) {
        const r = op - 0x90;
        const v1 = e.reg.AX; e.reg.AX = getReg16(r); setReg16(r, v1);
        return true;
    }

    if (op === 0xA8 || op === 0xA9) {
        const isWord = op === 0xA9;
        const imm = isWord ? fetch16() : fetch8();
        const dst = isWord ? e.reg.AX : (e.reg.AX & 0xFF);
        const res = dst & imm;
        updFlags(res, isWord); e.flags.CF = 0; e.flags.OF = 0; e.flags.PF = calcParity(res);
        return true;
    }
    
    if (op === 0xF6 || op === 0xF7) {
        const isWord = op === 0xF7;
        const m = modrmDec();
        if (m.reg === 0 || m.reg === 1) { 
            const imm = isWord ? fetch16() : fetch8();
            const v1 = rmRd(m, isWord);
            const res = v1 & imm;
            updFlags(res, isWord); e.flags.CF = 0; e.flags.OF = 0; e.flags.PF = calcParity(res);
        } else if (m.reg === 2) { 
            const v = rmRd(m, isWord);
            rmWr(m, isWord, (~v) & (isWord ? 0xFFFF : 0xFF));
        } else if (m.reg === 3) {
            const signBit = isWord ? 0x8000 : 0x80;
            const v = rmRd(m, isWord);
            const res = (0 - v) & (isWord ? 0xFFFF : 0xFF);
            rmWr(m, isWord, res); updFlags(res, isWord);
            e.flags.CF = v === 0 ? 0 : 1; e.flags.PF = calcParity(res);
            e.flags.OF = v === signBit ? 1 : 0;
            e.flags.AF = computeAF(0, v, res); // NEG sets AF based on low-nibble borrow
        } else if (m.reg === 4 || m.reg === 5) { 
            const v = rmRd(m, isWord);
            if (isWord) {
                const u1 = e.reg.AX;
                if (m.reg === 4) {
                    const ur = (u1 * v) >>> 0; e.reg.AX = ur & 0xFFFF; e.reg.DX = (ur >>> 16) & 0xFFFF; e.flags.CF = e.flags.OF = e.reg.DX !== 0 ? 1 : 0;
                } else {
                    const sr = ((u1 << 16) >> 16) * ((v << 16) >> 16); e.reg.AX = sr & 0xFFFF; e.reg.DX = (sr >> 16) & 0xFFFF; e.flags.CF = e.flags.OF = ((e.reg.AX & 0x8000) ? e.reg.DX === 0xFFFF : e.reg.DX === 0) ? 0 : 1;
                }
            } else {
                const u1 = e.reg.AX & 0xFF;
                if (m.reg === 4) {
                    const ur = u1 * v; e.reg.AX = ur & 0xFFFF; e.flags.CF = e.flags.OF = (ur & 0xFF00) !== 0 ? 1 : 0;
                } else {
                    const sr = ((u1 << 24) >> 24) * ((v << 24) >> 24); e.reg.AX = sr & 0xFFFF; e.flags.CF = e.flags.OF = ((sr & 0x80) ? (sr & 0xFF00) === 0xFF00 : (sr & 0xFF00) === 0) ? 0 : 1;
                }
            }
        } else if (m.reg === 6 || m.reg === 7) {
            const d = rmRd(m, isWord);
            if (d === 0) { raiseInt(e, 0); return true; } // #DE — divide by zero
            if (isWord) {
                if (m.reg === 6) {
                    // Unsigned 32/16 → 16:16
                    const dvnd = (e.reg.DX * 0x10000) + e.reg.AX;
                    const q = Math.floor(dvnd / d);
                    if (q > 0xFFFF) { raiseInt(e, 0); return true; }
                    e.reg.AX = q & 0xFFFF; e.reg.DX = dvnd % d;
                } else {
                    // Signed 32/16 → 16:16 — sign-extend DX:AX properly.
                    const hi = (e.reg.DX << 16) >> 16; // signed 16
                    const dvnd = hi * 0x10000 + e.reg.AX;
                    const ds = (d << 16) >> 16;
                    const q = Math.trunc(dvnd / ds);
                    if (q > 32767 || q < (is186 ? -32768 : -32767)) { raiseInt(e, 0); return true; } // 8086 also faults on 0x8000
                    e.reg.AX = q & 0xFFFF; e.reg.DX = (dvnd - q * ds) & 0xFFFF;
                }
            } else {
                if (m.reg === 6) {
                    const dvnd = e.reg.AX;
                    const q = Math.floor(dvnd / d);
                    if (q > 0xFF) { raiseInt(e, 0); return true; }
                    e.reg.AX = ((dvnd % d) << 8) | (q & 0xFF);
                } else {
                    const dvnd = (e.reg.AX << 16) >> 16; const ds = (d << 24) >> 24;
                    const q = Math.trunc(dvnd / ds);
                    if (q > 127 || q < (is186 ? -128 : -127)) { raiseInt(e, 0); return true; } // 8086 also faults on 0x80
                    e.reg.AX = (((dvnd - q * ds) & 0xFF) << 8) | (q & 0xFF);
                }
            }
        }
        return true;
    }

    if (op === 0x9C) { push16(e, packFlags(e)); return true; }
    if (op === 0x9D) { unpackFlags(e, pop16(e)); return true; }
    if (op === 0x98) { e.reg.AX = (e.reg.AX & 0x80) ? (0xFF00 | (e.reg.AX & 0xFF)) : (e.reg.AX & 0xFF); return true; } 
    if (op === 0x99) { e.reg.DX = (e.reg.AX & 0x8000) ? 0xFFFF : 0x0000; return true; } 
    if (op === 0x9E) { const ah = (e.reg.AX >> 8) & 0xFF; e.flags.CF=(ah&1)?1:0; e.flags.PF=(ah&4)?1:0; e.flags.AF=(ah&16)?1:0; e.flags.ZF=(ah&64)?1:0; e.flags.SF=(ah&128)?1:0; return true; } // SAHF
    if (op === 0x9F) { let ah=2; if(e.flags.CF)ah|=1; if(e.flags.PF)ah|=4; if(e.flags.AF)ah|=16; if(e.flags.ZF)ah|=64; if(e.flags.SF)ah|=128; e.reg.AX=(e.reg.AX&0xFF)|(ah<<8); return true; } // LAHF

    // BCD adjust instructions — all operate on AL (and AH for unpacked variants).
    if (op === 0x27) { // DAA — decimal-adjust after add (packed BCD)
        const oldAL = e.reg.AX & 0xFF; const oldCF = e.flags.CF;
        let AL = oldAL; let CF = 0;
        if ((AL & 0x0F) > 9 || e.flags.AF) { const sum = AL + 6; AL = sum & 0xFF; CF = oldCF | (sum > 0xFF ? 1 : 0); e.flags.AF = 1; } else { e.flags.AF = 0; }
        if (oldAL > 0x99 || oldCF) { AL = (AL + 0x60) & 0xFF; CF = 1; }
        e.reg.AX = (e.reg.AX & 0xFF00) | AL; e.flags.CF = CF;
        e.flags.ZF = AL === 0 ? 1 : 0; e.flags.SF = (AL & 0x80) ? 1 : 0; e.flags.PF = calcParity(AL);
        return true;
    }
    if (op === 0x2F) { // DAS — decimal-adjust after sub (packed BCD)
        const oldAL = e.reg.AX & 0xFF; const oldCF = e.flags.CF;
        let AL = oldAL; let CF = 0;
        if ((AL & 0x0F) > 9 || e.flags.AF) { const diff = AL - 6; AL = diff & 0xFF; CF = oldCF | (diff < 0 ? 1 : 0); e.flags.AF = 1; } else { e.flags.AF = 0; }
        if (oldAL > 0x99 || oldCF) { AL = (AL - 0x60) & 0xFF; CF = 1; }
        e.reg.AX = (e.reg.AX & 0xFF00) | AL; e.flags.CF = CF;
        e.flags.ZF = AL === 0 ? 1 : 0; e.flags.SF = (AL & 0x80) ? 1 : 0; e.flags.PF = calcParity(AL);
        return true;
    }
    if (op === 0x37) { // AAA — ASCII-adjust after add (unpacked BCD)
        let AL = e.reg.AX & 0xFF; let AH = (e.reg.AX >> 8) & 0xFF;
        if ((AL & 0x0F) > 9 || e.flags.AF) { AL = (AL + 6) & 0xFF; AH = (AH + 1) & 0xFF; e.flags.AF = 1; e.flags.CF = 1; } else { e.flags.AF = 0; e.flags.CF = 0; }
        AL &= 0x0F;
        e.reg.AX = (AH << 8) | AL;
        return true;
    }
    if (op === 0x3F) { // AAS — ASCII-adjust after sub (unpacked BCD)
        let AL = e.reg.AX & 0xFF; let AH = (e.reg.AX >> 8) & 0xFF;
        if ((AL & 0x0F) > 9 || e.flags.AF) { AL = (AL - 6) & 0xFF; AH = (AH - 1) & 0xFF; e.flags.AF = 1; e.flags.CF = 1; } else { e.flags.AF = 0; e.flags.CF = 0; }
        AL &= 0x0F;
        e.reg.AX = (AH << 8) | AL;
        return true;
    }
    if (op === 0xD4) { // AAM — ASCII-adjust after multiply (base in imm8, normally 10)
        const base = fetch8();
        if (base === 0) { raiseInt(e, 0); return true; } // divide-by-zero on 8086
        const AL = e.reg.AX & 0xFF;
        const AH = Math.floor(AL / base); const newAL = AL % base;
        e.reg.AX = (AH << 8) | newAL;
        e.flags.ZF = newAL === 0 ? 1 : 0; e.flags.SF = (newAL & 0x80) ? 1 : 0; e.flags.PF = calcParity(newAL);
        return true;
    }
    if (op === 0xD5) { // AAD — ASCII-adjust before divide (base in imm8, normally 10)
        const base = fetch8();
        const AL = e.reg.AX & 0xFF; const AH = (e.reg.AX >> 8) & 0xFF;
        const newAL = (AH * base + AL) & 0xFF;
        e.reg.AX = newAL;
        e.flags.ZF = newAL === 0 ? 1 : 0; e.flags.SF = (newAL & 0x80) ? 1 : 0; e.flags.PF = calcParity(newAL);
        return true;
    }
    if (op === 0xD7) { const phys = calcPhys(segOv !== null ? segOv : e.reg.DS, (e.reg.BX + (e.reg.AX & 0xFF)) & 0xFFFF); e.reg.AX = (e.reg.AX & 0xFF00) | readMem8(e, phys); return true; } // XLAT

    if (op === 0xE4 || op === 0xE5) {
        const isWord = op === 0xE5; const port = fetch8();
        const val = isWord ? ctx.bus.readWord(port) : ctx.bus.read(port);
        if (isWord) setReg16(0, val); else setReg8(0, val);
        return true;
    }
    if (op === 0xEC || op === 0xED) {
        const isWord = op === 0xED; const port = e.reg.DX;
        const val = isWord ? ctx.bus.readWord(port) : ctx.bus.read(port);
        if (isWord) setReg16(0, val); else setReg8(0, val);
        return true;
    }
    if (op === 0xE6 || op === 0xE7) {
        const isWord = op === 0xE7; const port = fetch8();
        if (isWord) ctx.bus.writeWord(port, e.reg.AX); else ctx.bus.write(port, e.reg.AX & 0xFF);
        return true;
    }
    if (op === 0xEE || op === 0xEF) {
        const isWord = op === 0xEF; const port = e.reg.DX;
        if (isWord) ctx.bus.writeWord(port, e.reg.AX); else ctx.bus.write(port, e.reg.AX & 0xFF);
        return true;
    }
    
    if (op === 0xC0 || op === 0xC1 || (op >= 0xD0 && op <= 0xD3)) {
        const isWord = op === 0xC1 || op === 0xD1 || op === 0xD3;
        const isCL = op === 0xD2 || op === 0xD3;
        const isImm = op === 0xC0 || op === 0xC1;
        const m = modrmDec();
        
        let count = 1;
        if (isCL) count = e.reg.CX & 0xFF; else if (isImm) count = fetch8();
        if (is186) count &= 0x1F; // only the 186+ masks the count; the 8086 honours all 8 bits of CL

        // Undocumented 8086 SETMO (D0/D1 /6) and SETMOC (D2/D3 /6, only when CL != 0): set every bit.
        if (m.reg === 6 && !is186) {
            if (count > 0) {
                rmWr(m, isWord, isWord ? 0xFFFF : 0xFF);
                e.flags.CF = 0; e.flags.OF = 0; e.flags.AF = 0; e.flags.SF = 1; e.flags.ZF = 0; e.flags.PF = 1;
            }
            return true;
        }

        if (count > 0) {
            let val = rmRd(m, isWord);
            const origVal = val;
            const msbMask = isWord ? 0x8000 : 0x80;
            const nextMsbMask = isWord ? 0x4000 : 0x40;
            const maxVal = isWord ? 0xFFFF : 0xFF;
            const shiftAmt = isWord ? 15 : 7;

            for (let i = 0; i < count; i++) {
                const msb = (val & msbMask) !== 0; const lsb = (val & 1) !== 0;
                if (m.reg === 0) { e.flags.CF = msb ? 1 : 0; val = ((val << 1) | e.flags.CF) & maxVal; }
                else if (m.reg === 1) { e.flags.CF = lsb ? 1 : 0; val = ((val >> 1) | (e.flags.CF << shiftAmt)) & maxVal; }
                else if (m.reg === 2) { const oldCF = e.flags.CF; e.flags.CF = msb ? 1 : 0; val = ((val << 1) | oldCF) & maxVal; }
                else if (m.reg === 3) { const oldCF = e.flags.CF; e.flags.CF = lsb ? 1 : 0; val = ((val >> 1) | (oldCF << shiftAmt)) & maxVal; }
                else if (m.reg === 4 || m.reg === 6) { e.flags.CF = msb ? 1 : 0; val = (val << 1) & maxVal; }
                else if (m.reg === 5) { e.flags.CF = lsb ? 1 : 0; val = (val >> 1) & maxVal; }
                else if (m.reg === 7) { e.flags.CF = lsb ? 1 : 0; val = (val & msbMask) | ((val >> 1) & (maxVal >> 1)); }
            }
            rmWr(m, isWord, val);
            // SHL/SHR/SAR (m.reg 4–7) affect ZF/SF/PF; rotates (0–3) leave them alone.
            if (m.reg >= 4) { updFlags(val, isWord); e.flags.PF = calcParity(val); }

            // OF is defined only when count == 1. For count > 1 the 8086 leaves OF undefined; we leave it alone.
            if (count === 1) {
                const newMsb = (val & msbMask) ? 1 : 0;
                if (m.reg === 0 || m.reg === 2 || m.reg === 4 || m.reg === 6) {
                    e.flags.OF = newMsb ^ e.flags.CF;                       // ROL / RCL / SHL / SAL
                } else if (m.reg === 1 || m.reg === 3) {
                    const nextMsb = (val & nextMsbMask) ? 1 : 0;
                    e.flags.OF = newMsb ^ nextMsb;                          // ROR / RCR
                } else if (m.reg === 5) {
                    e.flags.OF = (origVal & msbMask) ? 1 : 0;               // SHR — old MSB
                } else if (m.reg === 7) {
                    e.flags.OF = 0;                                         // SAR — sign bit cannot change
                }
            }
        }
        return true;
    }

    if (op === 0xE8) { const off = fetch16(); push16(e, e.reg.IP); e.reg.IP = (e.reg.IP + (off<<16>>16)) & 0xFFFF; return true; } 
    if (op === 0xE9) { const off = fetch16(); e.reg.IP = (e.reg.IP + (off<<16>>16)) & 0xFFFF; return true; } 
    if (op === 0xEB) { const off = fetch8()<<24>>24; e.reg.IP = (e.reg.IP + off) & 0xFFFF; return true; } 
    if (op === 0xE0) { const off = fetch8()<<24>>24; e.reg.CX=(e.reg.CX-1)&0xFFFF; if (e.reg.CX!==0 && e.flags.ZF===0) e.reg.IP=(e.reg.IP+off)&0xFFFF; return true; } // LOOPNE/LOOPNZ
    if (op === 0xE1) { const off = fetch8()<<24>>24; e.reg.CX=(e.reg.CX-1)&0xFFFF; if (e.reg.CX!==0 && e.flags.ZF===1) e.reg.IP=(e.reg.IP+off)&0xFFFF; return true; } // LOOPE/LOOPZ
    if (op === 0xE2) { const off = fetch8()<<24>>24; e.reg.CX=(e.reg.CX-1)&0xFFFF; if (e.reg.CX!==0) e.reg.IP=(e.reg.IP+off)&0xFFFF; return true; } 
    if (op === 0xE3) { const off = fetch8()<<24>>24; if (e.reg.CX===0) e.reg.IP=(e.reg.IP+off)&0xFFFF; return true; } // JCXZ
    if (op === 0xC3) { e.reg.IP = pop16(e); return true; } 
    if (op === 0xC2) { const bytes = fetch16(); e.reg.IP = pop16(e); e.reg.SP = (e.reg.SP + bytes) & 0xFFFF; return true; } 
    if (op === 0xCB) { e.reg.IP = pop16(e); e.reg.CS = pop16(e); return true; } 
    if (op === 0xCA) { const bytes = fetch16(); e.reg.IP = pop16(e); e.reg.CS = pop16(e); e.reg.SP = (e.reg.SP + bytes) & 0xFFFF; return true; } 
    if (op === 0xCF) { e.reg.IP = pop16(e); e.reg.CS = pop16(e); unpackFlags(e, pop16(e)); return true; } 
    if (op === 0xEA) { const ip = fetch16(); const cs = fetch16(); e.reg.IP = ip; e.reg.CS = cs; return true; } 
    if (op === 0x9A) { const ip = fetch16(); const cs = fetch16(); push16(e, e.reg.CS); push16(e, e.reg.IP); e.reg.IP = ip; e.reg.CS = cs; return true; } 

    if (op >= 0x70 && op <= 0x7F) {
        const off = fetch8()<<24>>24;
        let cond = false;
        switch(op) {
            case 0x70: cond = e.flags.OF === 1; break; 
            case 0x71: cond = e.flags.OF === 0; break; 
            case 0x72: cond = e.flags.CF === 1; break; 
            case 0x73: cond = e.flags.CF === 0; break; 
            case 0x74: cond = e.flags.ZF === 1; break; 
            case 0x75: cond = e.flags.ZF === 0; break; 
            case 0x76: cond = e.flags.CF === 1 || e.flags.ZF === 1; break; 
            case 0x77: cond = e.flags.CF === 0 && e.flags.ZF === 0; break; 
            case 0x78: cond = e.flags.SF === 1; break; 
            case 0x79: cond = e.flags.SF === 0; break; 
            case 0x7A: cond = e.flags.PF === 1; break; 
            case 0x7B: cond = e.flags.PF === 0; break; 
            case 0x7C: cond = e.flags.SF !== e.flags.OF; break; 
            case 0x7D: cond = e.flags.SF === e.flags.OF; break; 
            case 0x7E: cond = e.flags.ZF === 1 || e.flags.SF !== e.flags.OF; break; 
            case 0x7F: cond = e.flags.ZF === 0 && e.flags.SF === e.flags.OF; break; 
        }
        if (cond) e.reg.IP = (e.reg.IP + off) & 0xFFFF;
        return true;
    }

    if (op === 0xCD) { raiseInt(e, fetch8()); return true; } // INT n — always through the IVT

    if ((op >= 0xA4 && op <= 0xA7) || (op >= 0xAA && op <= 0xAF) || (is186 && op >= 0x6C && op <= 0x6F)) {
        const isWord = (op % 2) === 1;
        const sz = isWord ? 2 : 1;
        const dir = e.flags.DF === 0 ? sz : -sz;
        const srcSeg = segOv !== null ? segOv : e.reg.DS;
        const rdSeg = (seg, off) => isWord ? readWordSeg(e, seg, off) : readMem8(e, calcPhys(seg, off));
        const wrSeg = (seg, off, v) => { if (isWord) writeWordSeg(e, seg, off, v); else writeMem8(e, calcPhys(seg, off), v); };

        const doStringOp = () => {
            if (op === 0xA4 || op === 0xA5) { // MOVS
                wrSeg(e.reg.ES, e.reg.DI, rdSeg(srcSeg, e.reg.SI));
                e.reg.SI = (e.reg.SI + dir) & 0xFFFF; e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
            } else if (op === 0xAC || op === 0xAD) { // LODS
                if (isWord) setReg16(0, rdSeg(srcSeg, e.reg.SI)); else setReg8(0, rdSeg(srcSeg, e.reg.SI));
                e.reg.SI = (e.reg.SI + dir) & 0xFFFF;
            } else if (op === 0xAA || op === 0xAB) { // STOS
                wrSeg(e.reg.ES, e.reg.DI, isWord ? getReg16(0) : getReg8(0));
                e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
            } else if (op === 0x6C || op === 0x6D) { // INS (186): port DX -> ES:DI
                wrSeg(e.reg.ES, e.reg.DI, isWord ? ctx.bus.readWord(e.reg.DX) : ctx.bus.read(e.reg.DX));
                e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
            } else if (op === 0x6E || op === 0x6F) { // OUTS (186): DS:SI -> port DX
                const v = rdSeg(srcSeg, e.reg.SI);
                if (isWord) ctx.bus.writeWord(e.reg.DX, v); else ctx.bus.write(e.reg.DX, v);
                e.reg.SI = (e.reg.SI + dir) & 0xFFFF;
            } else if (op === 0xA6 || op === 0xA7 || op === 0xAE || op === 0xAF) { // CMPS / SCAS
                let v1, v2;
                if (op === 0xA6 || op === 0xA7) {
                    v1 = rdSeg(srcSeg, e.reg.SI);
                    v2 = rdSeg(e.reg.ES, e.reg.DI);
                    e.reg.SI = (e.reg.SI + dir) & 0xFFFF;
                } else {
                    v1 = isWord ? getReg16(0) : getReg8(0);
                    v2 = rdSeg(e.reg.ES, e.reg.DI);
                }
                e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
                // CMPS/SCAS: full SUB-style flag set (ZF/SF/PF/CF/OF/AF).
                applyAluFlags(e, aluCompute(7, v1, v2, isWord, 0));
            }
        };

        if (repPrefix !== 0) {
            if (e.reg.CX === 0) return true;
            doStringOp(); e.reg.CX = (e.reg.CX - 1) & 0xFFFF;
            let repeat = e.reg.CX !== 0;
            if (op === 0xA6 || op === 0xA7 || op === 0xAE || op === 0xAF) {
                if (repPrefix === 0xF3) repeat = repeat && (e.flags.ZF === 1); 
                if (repPrefix === 0xF2) repeat = repeat && (e.flags.ZF === 0); 
            }
            if (repeat) e.reg.IP = opIP; 
        } else doStringOp();
        return true;
    }

    // Anything left is undefined. The 186 raises INT 6 with the faulting instruction's address;
    // the 8086 has no such trap and simply ignores the instruction.
    return undefinedOp();
};

/**
 * Execute one CPU step: one instruction (or an idle tick while halted) followed by the
 * single-step trap and hardware-interrupt checks.
 * @param {object} e - CPU engine state
 * @param {object} ctx - External context: { bus, keyboard, shiftState, pic }
 * @returns {boolean} true to continue, false to stop (HLT with nothing able to wake the CPU)
 */
const executeStep = (e, ctx) => {
    let result = true;
    if (!e.halted) {
        const trap = e.flags.TF; // TF is sampled before the instruction runs
        result = executeBinaryStep(e, ctx);
        if (result && trap && e.flags.TF) raiseInt(e, 1); // single-step trap
    }
    // STI / MOV SS / POP SS: the instruction that follows runs before any IRQ is recognised.
    if (e.inhibitIRQ) { e.inhibitIRQ = false; return result; }
    if (ctx.pic && e.flags.IF && ctx.pic.hasPendingInterrupt()) {
        const vector = ctx.pic.acknowledge();
        if (vector >= 0) {
            e.halted = false;
            raiseInt(e, vector);
        }
    }
    return result;
};

export {
    ROM_BASE,
    ADDR_SPACE,
    DISK_SIZE,
    SECTOR_SIZE,
    FLOPPY_SIZE,
    VGA_BASE,
    VGA_COLS,
    VGA_ROWS,
    VGA_SIZE,
    toHex,
    calcPhys,
    calcParity,
    readMem8,
    writeMem8,
    writeMem8Safe,
    readMemWord,
    writeMemWord,
    readWordSeg,
    writeWordSeg,
    push16,
    pop16,
    raiseInt,
    createEngine,
    packFlags,
    unpackFlags,
    executeBinaryStep,
    executeStep,
};
