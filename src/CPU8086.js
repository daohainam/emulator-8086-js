// ==========================================
// CPU8086 — Intel 8086 Processor Emulation
// ==========================================

// --- HARDWARE CONSTANTS ---
const ADDR_SPACE     = 1048576; // Total address space (1 MB)
const DISK_SIZE      = 131072;  // Virtual disk size (128 KB)
const SECTOR_SIZE    = 512;     // Standard disk sector size

const VGA_BASE       = 0xB8000; // VGA text mode VRAM base address
const VGA_COLS       = 80;      // VGA text mode columns
const VGA_ROWS       = 25;      // VGA text mode rows
const VGA_SIZE       = VGA_COLS * VGA_ROWS * 2; // 4000 Bytes

const toHex = (n, pad = 4) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(pad, '0');
const calcPhys = (s, o) => (((s & 0xFFFF) << 4) + (o & 0xFFFF)) & (ADDR_SPACE - 1);
const calcParity = (val) => {
    let p = 0, v = val & 0xFF;
    while (v) { p ^= (v & 1); v >>= 1; }
    return (p === 0) ? 1 : 0;
};

// ===============================================
// CORE: MEMORY MANAGER
// ===============================================
const readMem8 = (e, phys) => e.mem[phys];
const writeMem8 = (e, phys, val) => { e.mem[phys] = val & 0xFF; };
const writeMem8Safe = (e, phys, val) => { if (phys < ADDR_SPACE) e.mem[phys] = val & 0xFF; };

const readMemWord = (e, phys) => readMem8(e, phys) | (readMem8(e, phys + 1) << 8);
const writeMemWord = (e, phys, val) => { writeMem8(e, phys, val & 0xFF); writeMem8(e, phys + 1, (val >> 8) & 0xFF); };
const push16 = (e, val) => { e.reg.SP = (e.reg.SP - 2) & 0xFFFF; writeMemWord(e, calcPhys(e.reg.SS, e.reg.SP), val); };
const pop16 = (e) => { const val = readMemWord(e, calcPhys(e.reg.SS, e.reg.SP)); e.reg.SP = (e.reg.SP + 2) & 0xFFFF; return val; };

const packFlags = (e) => {
    const f = e.flags; let r = 0;
    if (f.CF) r |= (1<<0); if (f.PF) r |= (1<<2); if (f.AF) r |= (1<<4);
    if (f.ZF) r |= (1<<6); if (f.SF) r |= (1<<7); if (f.IF) r |= (1<<9);
    if (f.DF) r |= (1<<10); if (f.OF) r |= (1<<11);
    return r;
};
const unpackFlags = (e, r) => {
    const f = e.flags;
    f.CF = (r & (1<<0)) ? 1 : 0; f.PF = (r & (1<<2)) ? 1 : 0; f.AF = (r & (1<<4)) ? 1 : 0;
    f.ZF = (r & (1<<6)) ? 1 : 0; f.SF = (r & (1<<7)) ? 1 : 0; f.IF = (r & (1<<9)) ? 1 : 0;
    f.DF = (r & (1<<10)) ? 1 : 0; f.OF = (r & (1<<11)) ? 1 : 0;
};

// ===============================================
// BIOS INTERRUPT HANDLERS
// ===============================================

const handleInt10 = (e) => {
    const ax = e.reg.AX; const bx = e.reg.BX; const cx = e.reg.CX; const dx = e.reg.DX;
    const ah = (ax >> 8) & 0xFF; const al = ax & 0xFF;
    const bh = (bx >> 8) & 0xFF; const bl = bx & 0xFF;
    const ch = (cx >> 8) & 0xFF; const cl = cx & 0xFF;
    const dh = (dx >> 8) & 0xFF; const dl = dx & 0xFF;

    const scrollUp = (lines, attr, r1, c1, r2, c2) => {
        attr = attr || 0x07;
        if (lines === 0) { 
            for (let r = r1; r <= r2; r++) {
                for (let c = c1; c <= c2; c++) {
                    const idx = VGA_BASE + (r * 80 + c) * 2;
                    e.mem[idx] = 0; e.mem[idx + 1] = attr;
                }
            }
        } else {
            for (let r = r1; r <= r2 - lines; r++) {
                for (let c = c1; c <= c2; c++) {
                    const dest = VGA_BASE + (r * 80 + c) * 2;
                    const src = VGA_BASE + ((r + lines) * 80 + c) * 2;
                    e.mem[dest] = e.mem[src]; e.mem[dest + 1] = e.mem[src + 1];
                }
            }
            for (let r = r2 - lines + 1; r <= r2; r++) {
                for (let c = c1; c <= c2; c++) {
                    const idx = VGA_BASE + (r * 80 + c) * 2;
                    e.mem[idx] = 0; e.mem[idx + 1] = attr;
                }
            }
        }
    };

    if (ah === 0x00) { 
        for (let i = 0; i < VGA_SIZE; i += 2) { e.mem[VGA_BASE + i] = 0; e.mem[VGA_BASE + i + 1] = 0x07; }
        e.cursorX = 0; e.cursorY = 0;
    } else if (ah === 0x02) { 
        e.cursorY = Math.min(dh, 24);
        e.cursorX = Math.min(dl, 79);
    } else if (ah === 0x06) { 
        scrollUp(al, bh, ch, cl, dh, dl);
    } else if (ah === 0x09) { 
        let cX = e.cursorX; let cY = e.cursorY;
        for(let i = 0; i < cx; i++) {
            const idx = VGA_BASE + (cY * 80 + cX) * 2;
            e.mem[idx] = al; e.mem[idx+1] = bl;
            cX++; if (cX >= 80) { cX = 0; cY++; }
            if (cY >= 25) break; 
        }
    } else if (ah === 0x0E) { 
        if (al === 13) { e.cursorX = 0; } 
        else if (al === 10) { e.cursorY++; } 
        else if (al === 8) { if (e.cursorX > 0) e.cursorX--; } 
        else {
            const idx = VGA_BASE + (e.cursorY * 80 + e.cursorX) * 2;
            e.mem[idx] = al; e.mem[idx + 1] = 0x07;
            e.cursorX++;
        }
        if (e.cursorX >= 80) { e.cursorX = 0; e.cursorY++; }
        if (e.cursorY >= 25) { scrollUp(1, 0x07, 0, 0, 24, 79); e.cursorY = 24; }
    }
};

const handleInt13 = (e) => {
    const ah = (e.reg.AX >> 8) & 0xFF;
    const al = e.reg.AX & 0xFF;
    const dl = e.reg.DX & 0xFF;

    // Only handle first hard disk (0x80)
    if (dl !== 0x80) {
        e.reg.AX = (e.reg.AX & 0x00FF) | 0x0100; // AH=01 (invalid parameter)
        e.flags.CF = 1;
        return;
    }

    const TOTAL_SECTORS = Math.floor(DISK_SIZE / SECTOR_SIZE); // 128 sectors
    // CHS geometry: 1 head, 1 track per head, TOTAL_SECTORS sectors/track (simplified flat)
    const HEADS = 1;
    const SECTORS_PER_TRACK = 63; // standard max
    const CYLINDERS = Math.ceil(TOTAL_SECTORS / (HEADS * SECTORS_PER_TRACK));

    if (ah === 0x00) {
        // Reset disk system — return success
        e.reg.AX = (e.reg.AX & 0x00FF); // AH=0 (success)
        e.flags.CF = 0;
    } else if (ah === 0x01) {
        // Get status of last operation — return success
        e.reg.AX = (e.reg.AX & 0x00FF); // AH=0 (success)
        e.flags.CF = 0;
    } else if (ah === 0x02) {
        // Read sectors: AL=count, CH=cyl, CL=sector(1-based), DH=head, ES:BX=buffer
        const count = al;
        const cl = e.reg.CX & 0xFF;
        const ch = (e.reg.CX >> 8) & 0xFF;
        const dh = (e.reg.DX >> 8) & 0xFF;
        const sector = (cl & 0x3F);           // bits 0-5 of CL
        const cylinder = ch | ((cl & 0xC0) << 2); // CH + bits 6-7 of CL
        const head = dh;

        const lba = (cylinder * HEADS + head) * SECTORS_PER_TRACK + (sector - 1);
        const diskOffset = lba * SECTOR_SIZE;

        if (sector === 0 || diskOffset < 0 || diskOffset + count * SECTOR_SIZE > DISK_SIZE) {
            e.reg.AX = (e.reg.AX & 0x00FF) | 0x0400; // AH=04 (sector not found)
            e.flags.CF = 1;
            return;
        }

        const bufAddr = calcPhys(e.reg.ES, e.reg.BX);
        for (let i = 0; i < count * SECTOR_SIZE; i++) {
            writeMem8Safe(e, (bufAddr + i) & (ADDR_SPACE - 1), e.disk[diskOffset + i]);
        }
        e.reg.AX = (e.reg.AX & 0x00FF) | 0x0000; // AH=0 (success), AL preserved as sectors read
        e.flags.CF = 0;
    } else if (ah === 0x03) {
        // Write sectors: AL=count, CH=cyl, CL=sector(1-based), DH=head, ES:BX=buffer
        const count = al;
        const cl = e.reg.CX & 0xFF;
        const ch = (e.reg.CX >> 8) & 0xFF;
        const dh = (e.reg.DX >> 8) & 0xFF;
        const sector = (cl & 0x3F);
        const cylinder = ch | ((cl & 0xC0) << 2);
        const head = dh;

        const lba = (cylinder * HEADS + head) * SECTORS_PER_TRACK + (sector - 1);
        const diskOffset = lba * SECTOR_SIZE;

        if (sector === 0 || diskOffset < 0 || diskOffset + count * SECTOR_SIZE > DISK_SIZE) {
            e.reg.AX = (e.reg.AX & 0x00FF) | 0x0400; // AH=04 (sector not found)
            e.flags.CF = 1;
            return;
        }

        const bufAddr = calcPhys(e.reg.ES, e.reg.BX);
        for (let i = 0; i < count * SECTOR_SIZE; i++) {
            e.disk[diskOffset + i] = readMem8(e, (bufAddr + i) & (ADDR_SPACE - 1));
        }
        e.reg.AX = (e.reg.AX & 0x00FF) | 0x0000; // AH=0 (success)
        e.flags.CF = 0;
    } else if (ah === 0x08) {
        // Get drive parameters
        e.reg.AX = 0x0000; // AH=0 success
        e.reg.BX = 0x0000;
        e.reg.CX = ((CYLINDERS - 1) << 8) | SECTORS_PER_TRACK; // CH=max cyl, CL=max sector
        e.reg.DX = ((HEADS - 1) << 8) | 0x01; // DH=max head, DL=number of drives
        e.flags.CF = 0;
    } else if (ah === 0x15) {
        // Get disk type
        e.reg.AX = (e.reg.AX & 0x00FF) | 0x0300; // AH=03 (hard disk present)
        e.reg.CX = (TOTAL_SECTORS >> 16) & 0xFFFF;
        e.reg.DX = TOTAL_SECTORS & 0xFFFF;
        e.flags.CF = 0;
    } else {
        // Other functions — return success
        e.reg.AX = (e.reg.AX & 0x00FF); // AH=0
        e.flags.CF = 0;
    }
};

/**
 * JS fallback handler for INT 0x16 when no BIOS ROM is loaded.
 * Reads from the BDA keyboard circular buffer in memory (same layout that
 * the ASM int16_handler in int16.asm uses) so both paths are consistent.
 *
 * BDA layout (segment 0x0040, physical base 0x0400):
 *   0x0417 (phys) = BDA_KBD_STATUS1 — shift/toggle flags
 *   0x041A (phys) = BDA_KBD_HEAD    — head pointer (BDA-relative offset)
 *   0x041C (phys) = BDA_KBD_TAIL    — tail pointer (BDA-relative offset)
 *   0x041E (phys) = start of 32-byte circular buffer (BDA offset 0x1E)
 *   0x043E (phys) = one past end of buffer (BDA offset 0x3E)
 *
 * Entry word: low byte = ASCII code, high byte = scan code.
 * Buffer empty when head == tail.
 *
 * @param {object} e - CPU engine state
 */
const handleInt16 = (e) => {
    const BDA_BASE     = 0x0400;  // physical base of BDA segment
    const HEAD_PHYS    = 0x041A;
    const TAIL_PHYS    = 0x041C;
    const STATUS1_PHYS = 0x0417;
    const BUF_OFF_START = 0x1E;
    const BUF_OFF_END   = 0x3E;

    const ah = (e.reg.AX >> 8) & 0xFF;

    if (ah === 0x00 || ah === 0x10) {
        // Blocking read: re-execute INT 16h until a key is available
        const head = readMemWord(e, HEAD_PHYS);
        const tail = readMemWord(e, TAIL_PHYS);
        if (head === tail) {
            e.reg.IP = (e.reg.IP - 2) & 0xFFFF; // back up to re-execute
            return;
        }
        e.reg.AX = readMemWord(e, BDA_BASE + head);
        const nextHead = (head + 2 >= BUF_OFF_END) ? BUF_OFF_START : head + 2;
        writeMemWord(e, HEAD_PHYS, nextHead);
    } else if (ah === 0x01 || ah === 0x11) {
        // Non-destructive peek
        const head = readMemWord(e, HEAD_PHYS);
        const tail = readMemWord(e, TAIL_PHYS);
        if (head === tail) {
            e.flags.ZF = 1;
        } else {
            e.flags.ZF = 0;
            e.reg.AX = readMemWord(e, BDA_BASE + head);
        }
    } else if (ah === 0x02) {
        // Get shift status byte 1
        e.reg.AX = (e.reg.AX & 0xFF00) | readMem8(e, STATUS1_PHYS);
    } else if (ah === 0x12) {
        // Extended shift status: AL = status1, AH = status2
        e.reg.AX = ((readMem8(e, STATUS1_PHYS + 1)) << 8) | readMem8(e, STATUS1_PHYS);
    }
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
const executeBinaryStep = (e, ctx) => {
    let opIP = e.reg.IP;
    
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
    while ([0x26, 0x2E, 0x36, 0x3E, 0xF2, 0xF3].includes(op)) {
        if (op===0x26) segOv=e.reg.ES; if (op===0x2E) segOv=e.reg.CS;
        if (op===0x36) segOv=e.reg.SS; if (op===0x3E) segOv=e.reg.DS;
        if (op===0xF2 || op===0xF3) repPrefix = op;
        op = fetch8();
    }

    const modrmDec = (isWord) => {
        const b = fetch8();
        const mod = b>>6; const reg = (b>>3)&7; const rm = b&7;
        let addr = -1; let ds = e.reg.DS;
        let ea = 0;
        if (mod !== 3) {
            if(rm===0)ea=e.reg.BX+e.reg.SI; else if(rm===1)ea=e.reg.BX+e.reg.DI;
            else if(rm===2){ea=e.reg.BP+e.reg.SI;ds=e.reg.SS;} else if(rm===3){ea=e.reg.BP+e.reg.DI;ds=e.reg.SS;}
            else if(rm===4)ea=e.reg.SI; else if(rm===5)ea=e.reg.DI;
            else if(rm===6){if(mod===0)ea=fetch16();else{ea=e.reg.BP;ds=e.reg.SS;}}
            else if(rm===7)ea=e.reg.BX;
            if(mod===1)ea+=(fetch8()<<24>>24); else if(mod===2)ea+=fetch16();
            ea = ea & 0xFFFF;
            addr = calcPhys(segOv !== null ? segOv : ds, ea);
        }
        return {mod, reg, rm, addr, ea};
    };
    const rmRd = (m, w) => m.mod===3 ? (w?getReg16(m.rm):getReg8(m.rm)) : (w?readMemWord(e, m.addr):readMem8(e, m.addr));
    const rmWr = (m, w, v) => { if(m.mod===3) {if(w)setReg16(m.rm,v);else setReg8(m.rm,v);} else {if(w)writeMemWord(e, m.addr,v);else writeMem8(e, m.addr,v);} };

    const updFlags = (r, isWord) => {
        e.flags.ZF = (r & (isWord?0xFFFF:0xFF)) === 0 ? 1 : 0;
        e.flags.SF = (r & (isWord?0x8000:0x80)) ? 1 : 0;
    };

    if (op === 0x90) return true;
    if (op === 0xF4) return false;
    
    if (op === 0xFA) { e.flags.IF = 0; return true; } // CLI
    if (op === 0xFB) { e.flags.IF = 1; return true; } // STI
    if (op === 0xF8) { e.flags.CF = 0; return true; } // CLC
    if (op === 0xF9) { e.flags.CF = 1; return true; } // STC
    if (op === 0xFC) { e.flags.DF = 0; return true; } // CLD
    if (op === 0xFD) { e.flags.DF = 1; return true; } // STD
    if (op === 0xF5) { e.flags.CF = 1 - e.flags.CF; return true; } // CMC
    
    if (op >= 0xB8 && op <= 0xBF) { setReg16(op-0xB8, fetch16()); return true; } // MOV r16, imm16
    if (op >= 0xB0 && op <= 0xB7) { setReg8(op-0xB0, fetch8()); return true; } // MOV r8, imm8
    
    if (op === 0x8E) { const m = modrmDec(true); e.reg[["ES","CS","SS","DS"][m.reg]] = rmRd(m, true); return true; } // MOV Sreg, r/m
    if (op === 0x8C) { const m = modrmDec(true); rmWr(m, true, e.reg[["ES","CS","SS","DS"][m.reg]]); return true; } // MOV r/m, Sreg
    if (op === 0x8B) { const m = modrmDec(true); setReg16(m.reg, rmRd(m, true)); return true; } // MOV r16, r/m16
    if (op === 0x8A) { const m = modrmDec(false); setReg8(m.reg, rmRd(m, false)); return true; } // MOV r8, r/m8
    if (op === 0x89) { const m = modrmDec(true); rmWr(m, true, getReg16(m.reg)); return true; } // MOV r/m16, r16
    if (op === 0x88) { const m = modrmDec(false); rmWr(m, false, getReg8(m.reg)); return true; } // MOV r/m8, r8
    if (op === 0xC7) { const m = modrmDec(true); rmWr(m, true, fetch16()); return true; } // MOV r/m16, imm16
    if (op === 0xC6) { const m = modrmDec(false); rmWr(m, false, fetch8()); return true; } // MOV r/m8, imm8
    if (op === 0xC4 || op === 0xC5) { const m = modrmDec(true); if (m.mod===3) throw new Error("LDS/LES needs mem"); const off=readMemWord(e, m.addr); const seg=readMemWord(e, (m.addr+2)&0xFFFFF); setReg16(m.reg, off); if(op===0xC4) e.reg.ES=seg; else e.reg.DS=seg; return true; }

    if (op >= 0x40 && op <= 0x47) { const r=op-0x40; const orig=getReg16(r); const v=(orig+1)&0xFFFF; setReg16(r,v); updFlags(v,true); e.flags.OF=orig===0x7FFF?1:0; e.flags.PF=calcParity(v); return true; } // INC r16
    if (op >= 0x48 && op <= 0x4F) { const r=op-0x48; const orig=getReg16(r); const v=(orig-1)&0xFFFF; setReg16(r,v); updFlags(v,true); e.flags.OF=orig===0x8000?1:0; e.flags.PF=calcParity(v); return true; } // DEC r16
    if (op === 0xFE) { 
        const m=modrmDec(false); const orig=rmRd(m,false); 
        if (m.reg===0) { const res=orig+1; rmWr(m,false,res); updFlags(res,false); e.flags.OF=orig===0x7F?1:0; e.flags.PF=calcParity(res); }
        else if (m.reg===1) { const res=orig-1; rmWr(m,false,res); updFlags(res,false); e.flags.OF=orig===0x80?1:0; e.flags.PF=calcParity(res); }
        return true; 
    }
    if (op === 0xFF) { 
        const m=modrmDec(true); 
        if(m.reg===0) { const orig=rmRd(m,true); const res=orig+1; rmWr(m,true,res); updFlags(res,true); e.flags.OF=orig===0x7FFF?1:0; e.flags.PF=calcParity(res); }
        else if(m.reg===1) { const orig=rmRd(m,true); const res=orig-1; rmWr(m,true,res); updFlags(res,true); e.flags.OF=orig===0x8000?1:0; e.flags.PF=calcParity(res); }
        else if(m.reg===2||m.reg===4){ if(m.reg===2) push16(e, e.reg.IP); e.reg.IP=rmRd(m,true); }
        else if(m.reg===6) push16(e, rmRd(m,true));
        return true;
    }

    if (op >= 0x50 && op <= 0x57) { push16(e, getReg16(op-0x50)); return true; } // PUSH r16
    if (op >= 0x58 && op <= 0x5F) { setReg16(op-0x58, pop16(e)); return true; } // POP r16
    if (op === 0x06) { push16(e, e.reg.ES); return true; } // PUSH ES
    if (op === 0x07) { e.reg.ES = pop16(e); return true; } // POP ES
    if (op === 0x0E) { push16(e, e.reg.CS); return true; } // PUSH CS
    if (op === 0x16) { push16(e, e.reg.SS); return true; } // PUSH SS
    if (op === 0x17) { e.reg.SS = pop16(e); return true; } // POP SS
    if (op === 0x1E) { push16(e, e.reg.DS); return true; } // PUSH DS
    if (op === 0x1F) { e.reg.DS = pop16(e); return true; } // POP DS
    if (op === 0x60) { const sp = e.reg.SP; push16(e, e.reg.AX); push16(e, e.reg.CX); push16(e, e.reg.DX); push16(e, e.reg.BX); push16(e, sp); push16(e, e.reg.BP); push16(e, e.reg.SI); push16(e, e.reg.DI); return true; } // PUSHA
    if (op === 0x61) { e.reg.DI = pop16(e); e.reg.SI = pop16(e); e.reg.BP = pop16(e); pop16(e); e.reg.BX = pop16(e); e.reg.DX = pop16(e); e.reg.CX = pop16(e); e.reg.AX = pop16(e); return true; } // POPA
    if (op === 0xC9) { e.reg.SP = e.reg.BP; e.reg.BP = pop16(e); return true; } // LEAVE

    const isALUModRM = (op >= 0x00 && op <= 0x03) || (op >= 0x08 && op <= 0x0B) ||
                       (op >= 0x10 && op <= 0x13) || (op >= 0x18 && op <= 0x1B) ||
                       (op >= 0x20 && op <= 0x23) || (op >= 0x28 && op <= 0x2B) ||
                       (op >= 0x30 && op <= 0x33) || (op >= 0x38 && op <= 0x3B);
    if (isALUModRM) {
        const aluOp = (op >> 3) & 7;
        const isWord = (op & 1) === 1;
        const dir = (op & 2) !== 0; 
        const signBit = isWord ? 0x8000 : 0x80;
        const m = modrmDec(isWord);
        const rmVal = rmRd(m, isWord);
        const regVal = isWord ? getReg16(m.reg) : getReg8(m.reg);
        
        const dst = dir ? regVal : rmVal;
        const src = dir ? rmVal : regVal;
        
        let res = 0;
        if (aluOp===0) { res = dst + src; e.flags.CF = res > (isWord?0xFFFF:0xFF) ? 1 : 0; e.flags.OF = ((dst ^ res) & (src ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===1) { res = dst | src; e.flags.CF = 0; e.flags.OF = 0; }
        else if (aluOp===2) { res = dst + src + e.flags.CF; e.flags.CF = res > (isWord?0xFFFF:0xFF) ? 1 : 0; e.flags.OF = ((dst ^ res) & (src ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===3) { res = dst - src - e.flags.CF; e.flags.CF = dst < (src + e.flags.CF) ? 1 : 0; e.flags.OF = ((dst ^ src) & (dst ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===4) { res = dst & src; e.flags.CF = 0; e.flags.OF = 0; }
        else if (aluOp===5 || aluOp===7) { res = dst - src; e.flags.CF = dst < src ? 1 : 0; e.flags.OF = ((dst ^ src) & (dst ^ res) & signBit) ? 1 : 0; } 
        else if (aluOp===6) { res = dst ^ src; e.flags.CF = 0; e.flags.OF = 0; }
        
        updFlags(res, isWord); e.flags.PF = calcParity(res);
        
        if (aluOp !== 7) {
            if (dir) { if (isWord) setReg16(m.reg, res); else setReg8(m.reg, res); } 
            else rmWr(m, isWord, res);
        }
        return true;
    }

    const isALUAcc = (op & 0xC6) === 0x04;
    if (isALUAcc) {
        const aluOp = (op >> 3) & 7;
        const isWord = (op & 1) === 1;
        const signBit = isWord ? 0x8000 : 0x80;
        const imm = isWord ? fetch16() : fetch8();
        const dst = isWord ? getReg16(0) : getReg8(0);
        
        let res = 0;
        if (aluOp===0) { res = dst + imm; e.flags.CF = res > (isWord?0xFFFF:0xFF) ? 1 : 0; e.flags.OF = ((dst ^ res) & (imm ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===1) { res = dst | imm; e.flags.CF = 0; e.flags.OF = 0; }
        else if (aluOp===2) { res = dst + imm + e.flags.CF; e.flags.CF = res > (isWord?0xFFFF:0xFF) ? 1 : 0; e.flags.OF = ((dst ^ res) & (imm ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===3) { res = dst - imm - e.flags.CF; e.flags.CF = dst < (imm + e.flags.CF) ? 1 : 0; e.flags.OF = ((dst ^ imm) & (dst ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===4) { res = dst & imm; e.flags.CF = 0; e.flags.OF = 0; }
        else if (aluOp===5 || aluOp===7) { res = dst - imm; e.flags.CF = dst < imm ? 1 : 0; e.flags.OF = ((dst ^ imm) & (dst ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===6) { res = dst ^ imm; e.flags.CF = 0; e.flags.OF = 0; }
        
        updFlags(res, isWord); e.flags.PF = calcParity(res);
        if (aluOp !== 7) { if (isWord) setReg16(0, res); else setReg8(0, res); }
        return true;
    }

    if (op >= 0x80 && op <= 0x83) {
        const isWord = op === 0x81 || op === 0x83;
        const signBit = isWord ? 0x8000 : 0x80;
        const m = modrmDec(isWord);
        let imm = fetch8();
        if (op === 0x81) { const hi = fetch8(); imm = (hi << 8) | imm; } 
        else if (op === 0x83) imm = imm << 24 >> 24; 
        const dst = rmRd(m, isWord);
        const aluOp = m.reg;
        
        let res = 0;
        if (aluOp===0) { res = dst + imm; e.flags.CF = res > (isWord?0xFFFF:0xFF) ? 1 : 0; e.flags.OF = ((dst ^ res) & (imm ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===1) { res = dst | imm; e.flags.CF = 0; e.flags.OF = 0; }
        else if (aluOp===2) { res = dst + imm + e.flags.CF; e.flags.CF = res > (isWord?0xFFFF:0xFF) ? 1 : 0; e.flags.OF = ((dst ^ res) & (imm ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===3) { res = dst - imm - e.flags.CF; e.flags.CF = dst < (imm + e.flags.CF) ? 1 : 0; e.flags.OF = ((dst ^ imm) & (dst ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===4) { res = dst & imm; e.flags.CF = 0; e.flags.OF = 0; }
        else if (aluOp===5 || aluOp===7) { res = dst - imm; e.flags.CF = dst < imm ? 1 : 0; e.flags.OF = ((dst ^ imm) & (dst ^ res) & signBit) ? 1 : 0; }
        else if (aluOp===6) { res = dst ^ imm; e.flags.CF = 0; e.flags.OF = 0; }
        
        updFlags(res, isWord); e.flags.PF = calcParity(res);
        if (aluOp !== 7) rmWr(m, isWord, res);
        return true;
    }

    if (op === 0x84 || op === 0x85) {
        const isWord = op === 0x85;
        const m = modrmDec(isWord);
        const v1 = rmRd(m, isWord);
        const v2 = isWord ? getReg16(m.reg) : getReg8(m.reg);
        const res = v1 & v2;
        updFlags(res, isWord); e.flags.CF = 0; e.flags.OF = 0; e.flags.PF = calcParity(res);
        return true;
    }
    
    if (op === 0x8D) {
        const m = modrmDec(true);
        setReg16(m.reg, m.ea);
        return true;
    }

    if (op === 0x86 || op === 0x87) {
        const isWord = op === 0x87;
        const m = modrmDec(isWord);
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
        const m = modrmDec(isWord);
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
            if (d === 0) throw new Error("Divide by zero");
            if (isWord) {
                if (m.reg === 6) {
                    const dvnd = (e.reg.DX * 0x10000) + e.reg.AX;
                    const q = Math.floor(dvnd / d); if (q > 0xFFFF) throw new Error("Divide overflow");
                    e.reg.AX = q & 0xFFFF; e.reg.DX = dvnd % d;
                } else {
                    const dvnd = (e.reg.DX << 16) | e.reg.AX; const ds = (d << 16) >> 16;
                    const q = Math.trunc(dvnd / ds); if (q > 32767 || q < -32768) throw new Error("Divide overflow");
                    e.reg.AX = q & 0xFFFF; e.reg.DX = dvnd % ds;
                }
            } else {
                if (m.reg === 6) {
                    const dvnd = e.reg.AX;
                    const q = Math.floor(dvnd / d); if (q > 0xFF) throw new Error("Divide overflow");
                    e.reg.AX = ((dvnd % d) << 8) | (q & 0xFF);
                } else {
                    const dvnd = (e.reg.AX << 16) >> 16; const ds = (d << 24) >> 24;
                    const q = Math.trunc(dvnd / ds); if (q > 127 || q < -128) throw new Error("Divide overflow");
                    e.reg.AX = (((dvnd % ds) & 0xFF) << 8) | (q & 0xFF);
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
        const m = modrmDec(isWord);
        
        let count = 1;
        if (isCL) count = e.reg.CX & 0xFF; else if (isImm) count = fetch8();
        count &= 0x1F;

        if (count > 0) {
            let val = rmRd(m, isWord);
            const msbMask = isWord ? 0x8000 : 0x80;
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
            rmWr(m, isWord, val); updFlags(val, isWord); e.flags.PF = calcParity(val);
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

    if (op === 0xCD) {
        const iNum = fetch8();
        if (iNum === 0x10) handleInt10(e);
        else if (iNum === 0x13) handleInt13(e);
        else if (iNum === 0x16) handleInt16(e);
        else { push16(e, packFlags(e)); push16(e, e.reg.CS); push16(e, e.reg.IP); e.reg.IP = readMemWord(e, calcPhys(0, iNum*4)); e.reg.CS = readMemWord(e, calcPhys(0, iNum*4 + 2)); }
        return true;
    }

    if ((op >= 0xA4 && op <= 0xA7) || (op >= 0xAA && op <= 0xAF)) {
        const isWord = (op % 2) === 1;
        const sz = isWord ? 2 : 1;
        const dir = e.flags.DF === 0 ? sz : -sz;

        const doStringOp = () => {
            if (op === 0xA4 || op === 0xA5) { 
                const s = calcPhys(segOv !== null ? segOv : e.reg.DS, e.reg.SI);
                const d = calcPhys(e.reg.ES, e.reg.DI);
                if (isWord) writeMemWord(e, d, readMemWord(e, s)); else writeMem8(e, d, readMem8(e, s));
                e.reg.SI = (e.reg.SI + dir) & 0xFFFF; e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
            } else if (op === 0xAC || op === 0xAD) { 
                const s = calcPhys(segOv !== null ? segOv : e.reg.DS, e.reg.SI);
                if (isWord) setReg16(0, readMemWord(e, s)); else setReg8(0, readMem8(e, s)); 
                e.reg.SI = (e.reg.SI + dir) & 0xFFFF;
            } else if (op === 0xAA || op === 0xAB) { 
                const d = calcPhys(e.reg.ES, e.reg.DI);
                if (isWord) writeMemWord(e, d, getReg16(0)); else writeMem8(e, d, getReg8(0));
                e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
            } else if (op === 0xA6 || op === 0xA7 || op === 0xAE || op === 0xAF) { 
                const d = calcPhys(e.reg.ES, e.reg.DI);
                let v1, v2;
                if (op === 0xA6 || op === 0xA7) { 
                    const s = calcPhys(segOv !== null ? segOv : e.reg.DS, e.reg.SI);
                    v1 = isWord ? readMemWord(e, s) : readMem8(e, s);
                    v2 = isWord ? readMemWord(e, d) : readMem8(e, d);
                    e.reg.SI = (e.reg.SI + dir) & 0xFFFF;
                } else { 
                    v1 = isWord ? getReg16(0) : getReg8(0);
                    v2 = isWord ? readMemWord(e, d) : readMem8(e, d);
                }
                e.reg.DI = (e.reg.DI + dir) & 0xFFFF;
                const res = v1 - v2;
                updFlags(res, isWord); e.flags.CF = v1 < v2 ? 1 : 0; e.flags.PF = calcParity(res);
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

    throw new Error(`X86 BINARY ERROR: Unsupported Opcode 0x${op.toString(16).toUpperCase()} at ${toHex(e.reg.CS)}:${toHex(opIP)}`);
};

/**
 * Execute one CPU step with hardware interrupt checking.
 * @param {object} e - CPU engine state
 * @param {object} ctx - External context: { bus, keyboard, shiftState, pic }
 * @returns {boolean} true to continue, false to halt
 */
const executeStep = (e, ctx) => {
    const result = executeBinaryStep(e, ctx);
    // After each instruction, check for pending hardware interrupts
    if (ctx.pic && e.flags.IF && ctx.pic.hasPendingInterrupt()) {
        const vector = ctx.pic.acknowledge();
        if (vector >= 0) {
            push16(e, packFlags(e));
            e.flags.IF = 0; // disable interrupts while servicing
            push16(e, e.reg.CS);
            push16(e, e.reg.IP);
            e.reg.IP = readMemWord(e, calcPhys(0, vector * 4));
            e.reg.CS = readMemWord(e, calcPhys(0, vector * 4 + 2));
        }
    }
    return result;
};

export {
    ADDR_SPACE,
    DISK_SIZE,
    SECTOR_SIZE,
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
    push16,
    pop16,
    packFlags,
    unpackFlags,
    executeBinaryStep,
    executeStep,
};
