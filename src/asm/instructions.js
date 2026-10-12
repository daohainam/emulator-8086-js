// 8086 / 80186 instruction table.
//
// Each mnemonic maps to an ordered list of rules: { match, enc, cpu?, prefer?, size?, relax? }.
//   match : operand classes (see CLASS_TEST). Registers and sized memory operands are told apart,
//           so `word [bx]` and `byte [bx]` select different rules and an unsized `[bx]` that fits
//           several sizes is reported as ambiguous (like NASM) instead of silently picking one.
//   enc   : (operands, ctx) => byte[]   — operands already carry their final values in pass 2.
//   cpu   : minimum CPU ('186' for 80186 additions); default '8086'.
//   prefer: wins over other matching rules (e.g. the short A0-A3 accumulator MOVs).
//   size  : optional fixed size override (used by relaxable jumps).
//
// Operand objects (built by the assembler driver):
//   { type: 'reg8'|'reg16'|'sreg', reg }          register
//   { type: 'imm', value, unresolved }             immediate / address expression
//   { type: 'mem', mem: {rm, mod, dispSize, dispValue, direct, size} }   size: 8 | 16 | 32 | null
//   { type: 'farptr', seg: {value}, off: {value} } seg:off literal

export const REGISTERS = {
    AL: { name: 'AL', size: 8, code: 0 }, CL: { name: 'CL', size: 8, code: 1 },
    DL: { name: 'DL', size: 8, code: 2 }, BL: { name: 'BL', size: 8, code: 3 },
    AH: { name: 'AH', size: 8, code: 4 }, CH: { name: 'CH', size: 8, code: 5 },
    DH: { name: 'DH', size: 8, code: 6 }, BH: { name: 'BH', size: 8, code: 7 },
    AX: { name: 'AX', size: 16, code: 0 }, CX: { name: 'CX', size: 16, code: 1 },
    DX: { name: 'DX', size: 16, code: 2 }, BX: { name: 'BX', size: 16, code: 3 },
    SP: { name: 'SP', size: 16, code: 4 }, BP: { name: 'BP', size: 16, code: 5 },
    SI: { name: 'SI', size: 16, code: 6 }, DI: { name: 'DI', size: 16, code: 7 },
    ES: { name: 'ES', size: 16, code: 0, isSegment: true }, CS: { name: 'CS', size: 16, code: 1, isSegment: true },
    SS: { name: 'SS', size: 16, code: 2, isSegment: true }, DS: { name: 'DS', size: 16, code: 3, isSegment: true },
};

export const CPU_LEVEL = { '8086': 0, '186': 1 };

// ---------------------------------------------------------------- operand classes
const isMem = (o) => o.type === 'mem';
const memSized = (o, size) => isMem(o) && (o.mem.size === null || o.mem.size === size);
const isReg = (o, name) => (o.type === 'reg8' || o.type === 'reg16') && o.reg.name === name;

const CLASS_TEST = {
    r8: (o) => o.type === 'reg8',
    r16: (o) => o.type === 'reg16',
    sreg: (o) => o.type === 'sreg',
    al: (o) => isReg(o, 'AL'),
    cl: (o) => isReg(o, 'CL'),
    ax: (o) => isReg(o, 'AX'),
    dx: (o) => isReg(o, 'DX'),
    rm8: (o) => o.type === 'reg8' || memSized(o, 8),
    rm16: (o) => o.type === 'reg16' || memSized(o, 16),
    m8: (o) => memSized(o, 8),
    m16: (o) => memSized(o, 16),
    m32: (o) => isMem(o) && o.mem.size === 32,          // explicit `far` / `dword` only
    m: (o) => isMem(o),                                  // any memory operand (LEA, LDS, ...)
    moff8: (o) => memSized(o, 8) && o.mem.direct,        // [disp16] with no base/index register
    moff16: (o) => memSized(o, 16) && o.mem.direct,
    imm: (o) => o.type === 'imm',
    one: (o) => o.type === 'imm' && !o.unresolved && o.value === 1,
    farptr: (o) => o.type === 'farptr',
};

// Memory size a class commits to (null = does not constrain the size).
const CLASS_MEM_SIZE = { rm8: 8, m8: 8, moff8: 8, rm16: 16, m16: 16, moff16: 16, m32: 32, m: null };

// ---------------------------------------------------------------- encoding helpers
const le16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const le32 = (v) => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];
const modrmByte = (mod, reg, rm) => ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);

const dispBytes = (mem) => (mem.dispSize === 1 ? [mem.dispValue & 0xFF] : mem.dispSize === 2 ? le16(mem.dispValue) : []);

/** ModRM byte (+ displacement) for a register or memory r/m operand, with `reg` as the reg field. */
const modrm = (reg, rmOp) => (isMem(rmOp)
    ? [modrmByte(rmOp.mem.mod, reg, rmOp.mem.rm), ...dispBytes(rmOp.mem)]
    : [modrmByte(3, reg, rmOp.reg.code)]);

const fitsS8 = (o) => !o.unresolved && o.value >= -128 && o.value <= 127;

const checkRange = (v, bits, ctx) => {
    if (ctx.sizing) return;
    const lo = -(2 ** (bits - 1)); const hi = 2 ** bits - 1;
    if (v < lo || v > hi) ctx.warn(`value ${v} exceeds ${bits === 8 ? 'byte' : 'word'} range`);
};
const ib = (o, ctx) => { checkRange(o.value, 8, ctx); return [o.value & 0xFF]; };
const iw = (o, ctx) => { checkRange(o.value, 16, ctx); return le16(o.value); };

const rel8 = (target, ctx, instrSize) => {
    const rel = target - (ctx.offset + instrSize);
    if (!ctx.sizing && (rel < -128 || rel > 127)) throw new Error(`short jump out of range (distance ${rel}); conditional jumps and LOOP reach only -128..+127 bytes`);
    return rel & 0xFF;
};

const rule = (match, enc, opts = {}) => ({ match, enc, ...opts });
const simple = (bytes, opts = {}) => [rule([], () => bytes, opts)];

// ---------------------------------------------------------------- rule builders
const alu = (base, ext) => [
    rule(['rm8', 'r8'], (o) => [base + 0, ...modrm(o[1].reg.code, o[0])]),
    rule(['rm16', 'r16'], (o) => [base + 1, ...modrm(o[1].reg.code, o[0])]),
    rule(['r8', 'rm8'], (o) => [base + 2, ...modrm(o[0].reg.code, o[1])]),
    rule(['r16', 'rm16'], (o) => [base + 3, ...modrm(o[0].reg.code, o[1])]),
    rule(['al', 'imm'], (o, c) => [base + 4, ...ib(o[1], c)]),
    rule(['ax', 'imm'], (o, c) => [base + 5, ...iw(o[1], c)]),
    rule(['rm8', 'imm'], (o, c) => [0x80, ...modrm(ext, o[0]), ...ib(o[1], c)]),
    rule(['rm16', 'imm'], (o, c) => (fitsS8(o[1])
        ? [0x83, ...modrm(ext, o[0]), ...ib(o[1], c)]
        : [0x81, ...modrm(ext, o[0]), ...iw(o[1], c)])),
];

const unary = (ext) => [
    rule(['rm8'], (o) => [0xF6, ...modrm(ext, o[0])]),
    rule(['rm16'], (o) => [0xF7, ...modrm(ext, o[0])]),
];

const shift = (ext) => [
    rule(['rm8', 'one'], (o) => [0xD0, ...modrm(ext, o[0])]),
    rule(['rm16', 'one'], (o) => [0xD1, ...modrm(ext, o[0])]),
    rule(['rm8', 'cl'], (o) => [0xD2, ...modrm(ext, o[0])]),
    rule(['rm16', 'cl'], (o) => [0xD3, ...modrm(ext, o[0])]),
    rule(['rm8', 'imm'], (o, c) => [0xC0, ...modrm(ext, o[0]), ...ib(o[1], c)], { cpu: '186' }),
    rule(['rm16', 'imm'], (o, c) => [0xC1, ...modrm(ext, o[0]), ...ib(o[1], c)], { cpu: '186' }),
];

const condJump = (opcode) => [rule(['imm'], (o, c) => [opcode, rel8(o[0].value, c, 2)], { size: () => 2 })];

const stringOp = (bytes, cpu) => simple([bytes], cpu ? { cpu } : {});

// ---------------------------------------------------------------- the table
export const INSTRUCTIONS = {
    // --- no-operand instructions
    HLT: simple([0xF4]), NOP: simple([0x90]), WAIT: simple([0x9B]), FWAIT: simple([0x9B]), LOCK: simple([0xF0]),
    REP: simple([0xF3]), REPE: simple([0xF3]), REPZ: simple([0xF3]), REPNE: simple([0xF2]), REPNZ: simple([0xF2]),
    INTO: simple([0xCE]), IRET: simple([0xCF]), INT3: simple([0xCC]), SALC: simple([0xD6]),
    DAA: simple([0x27]), DAS: simple([0x2F]), AAA: simple([0x37]), AAS: simple([0x3F]),
    CLC: simple([0xF8]), STC: simple([0xF9]), CMC: simple([0xF5]), CLI: simple([0xFA]), STI: simple([0xFB]),
    CLD: simple([0xFC]), STD: simple([0xFD]), LAHF: simple([0x9F]), SAHF: simple([0x9E]),
    PUSHF: simple([0x9C]), POPF: simple([0x9D]), CBW: simple([0x98]), CWD: simple([0x99]),
    XLAT: simple([0xD7]), XLATB: simple([0xD7]),
    LODSB: stringOp(0xAC), LODSW: stringOp(0xAD), STOSB: stringOp(0xAA), STOSW: stringOp(0xAB),
    MOVSB: stringOp(0xA4), MOVSW: stringOp(0xA5), SCASB: stringOp(0xAE), SCASW: stringOp(0xAF),
    CMPSB: stringOp(0xA6), CMPSW: stringOp(0xA7),

    // --- 80186 additions (rejected on the 8086)
    PUSHA: simple([0x60], { cpu: '186' }), POPA: simple([0x61], { cpu: '186' }), LEAVE: simple([0xC9], { cpu: '186' }),
    INSB: stringOp(0x6C, '186'), INSW: stringOp(0x6D, '186'), OUTSB: stringOp(0x6E, '186'), OUTSW: stringOp(0x6F, '186'),
    ENTER: [rule(['imm', 'imm'], (o, c) => [0xC8, ...iw(o[0], c), ...ib(o[1], c)], { cpu: '186' })],
    BOUND: [rule(['r16', 'm'], (o) => [0x62, ...modrm(o[0].reg.code, o[1])], { cpu: '186' })],

    // --- interrupts / returns
    INT: [rule(['imm'], (o, c) => (!o[0].unresolved && o[0].value === 3 ? [0xCC] : [0xCD, ...ib(o[0], c)]))],
    RET: [rule([], () => [0xC3]), rule(['imm'], (o, c) => [0xC2, ...iw(o[0], c)])],
    RETN: [rule([], () => [0xC3]), rule(['imm'], (o, c) => [0xC2, ...iw(o[0], c)])],
    RETF: [rule([], () => [0xCB]), rule(['imm'], (o, c) => [0xCA, ...iw(o[0], c)])],

    // --- BCD adjust with optional base
    AAM: [rule([], () => [0xD4, 0x0A]), rule(['imm'], (o, c) => [0xD4, ...ib(o[0], c)])],
    AAD: [rule([], () => [0xD5, 0x0A]), rule(['imm'], (o, c) => [0xD5, ...ib(o[0], c)])],

    // --- arithmetic / logic
    ADD: alu(0x00, 0), OR: alu(0x08, 1), ADC: alu(0x10, 2), SBB: alu(0x18, 3),
    AND: alu(0x20, 4), SUB: alu(0x28, 5), XOR: alu(0x30, 6), CMP: alu(0x38, 7),
    NOT: unary(2), NEG: unary(3), MUL: unary(4), DIV: unary(6), IDIV: unary(7),
    IMUL: [
        ...unary(5),
        rule(['r16', 'rm16', 'imm'], (o, c) => (fitsS8(o[2])
            ? [0x6B, ...modrm(o[0].reg.code, o[1]), ...ib(o[2], c)]
            : [0x69, ...modrm(o[0].reg.code, o[1]), ...iw(o[2], c)]), { cpu: '186' }),
        rule(['r16', 'imm'], (o, c) => (fitsS8(o[1])
            ? [0x6B, ...modrm(o[0].reg.code, o[0]), ...ib(o[1], c)]
            : [0x69, ...modrm(o[0].reg.code, o[0]), ...iw(o[1], c)]), { cpu: '186' }),
    ],
    INC: [
        rule(['r16'], (o) => [0x40 + o[0].reg.code]),
        rule(['rm8'], (o) => [0xFE, ...modrm(0, o[0])]),
        rule(['rm16'], (o) => [0xFF, ...modrm(0, o[0])]),
    ],
    DEC: [
        rule(['r16'], (o) => [0x48 + o[0].reg.code]),
        rule(['rm8'], (o) => [0xFE, ...modrm(1, o[0])]),
        rule(['rm16'], (o) => [0xFF, ...modrm(1, o[0])]),
    ],

    ROL: shift(0), ROR: shift(1), RCL: shift(2), RCR: shift(3), SHL: shift(4), SAL: shift(4), SHR: shift(5), SAR: shift(7),

    TEST: [
        rule(['rm8', 'r8'], (o) => [0x84, ...modrm(o[1].reg.code, o[0])]),
        rule(['rm16', 'r16'], (o) => [0x85, ...modrm(o[1].reg.code, o[0])]),
        rule(['r8', 'm8'], (o) => [0x84, ...modrm(o[0].reg.code, o[1])]),
        rule(['r16', 'm16'], (o) => [0x85, ...modrm(o[0].reg.code, o[1])]),
        rule(['al', 'imm'], (o, c) => [0xA8, ...ib(o[1], c)]),
        rule(['ax', 'imm'], (o, c) => [0xA9, ...iw(o[1], c)]),
        rule(['rm8', 'imm'], (o, c) => [0xF6, ...modrm(0, o[0]), ...ib(o[1], c)]),
        rule(['rm16', 'imm'], (o, c) => [0xF7, ...modrm(0, o[0]), ...iw(o[1], c)]),
    ],

    // --- data movement
    MOV: [
        rule(['al', 'moff8'], (o) => [0xA0, ...le16(o[1].mem.dispValue)], { prefer: true }),
        rule(['ax', 'moff16'], (o) => [0xA1, ...le16(o[1].mem.dispValue)], { prefer: true }),
        rule(['moff8', 'al'], (o) => [0xA2, ...le16(o[0].mem.dispValue)], { prefer: true }),
        rule(['moff16', 'ax'], (o) => [0xA3, ...le16(o[0].mem.dispValue)], { prefer: true }),
        rule(['rm8', 'r8'], (o) => [0x88, ...modrm(o[1].reg.code, o[0])]),
        rule(['rm16', 'r16'], (o) => [0x89, ...modrm(o[1].reg.code, o[0])]),
        rule(['r8', 'rm8'], (o) => [0x8A, ...modrm(o[0].reg.code, o[1])]),
        rule(['r16', 'rm16'], (o) => [0x8B, ...modrm(o[0].reg.code, o[1])]),
        rule(['sreg', 'rm16'], (o) => {
            if (o[0].reg.name === 'CS') throw new Error('MOV to CS is not allowed');
            return [0x8E, ...modrm(o[0].reg.code, o[1])];
        }),
        rule(['rm16', 'sreg'], (o) => [0x8C, ...modrm(o[1].reg.code, o[0])]),
        rule(['r8', 'imm'], (o, c) => [0xB0 + o[0].reg.code, ...ib(o[1], c)]),
        rule(['r16', 'imm'], (o, c) => [0xB8 + o[0].reg.code, ...iw(o[1], c)]),
        rule(['m8', 'imm'], (o, c) => [0xC6, ...modrm(0, o[0]), ...ib(o[1], c)]),
        rule(['m16', 'imm'], (o, c) => [0xC7, ...modrm(0, o[0]), ...iw(o[1], c)]),
    ],
    XCHG: [
        rule(['ax', 'r16'], (o) => [0x90 + o[1].reg.code]),
        rule(['r16', 'ax'], (o) => [0x90 + o[0].reg.code]),
        rule(['rm8', 'r8'], (o) => [0x86, ...modrm(o[1].reg.code, o[0])]),
        rule(['r8', 'm8'], (o) => [0x86, ...modrm(o[0].reg.code, o[1])]),
        rule(['rm16', 'r16'], (o) => [0x87, ...modrm(o[1].reg.code, o[0])]),
        rule(['r16', 'm16'], (o) => [0x87, ...modrm(o[0].reg.code, o[1])]),
    ],
    LEA: [
        rule(['r16', 'm'], (o) => [0x8D, ...modrm(o[0].reg.code, o[1])]),
        // MASM-style `lea si, label` (no brackets) is not valid NASM but earlier versions of this
        // assembler accepted it and the bundled samples use it: treat it as `lea si, [label]`.
        rule(['r16', 'imm'], (o) => [0x8D, modrmByte(0, o[0].reg.code, 6), ...le16(o[1].value)]),
    ],
    LDS: [rule(['r16', 'm'], (o) => [0xC5, ...modrm(o[0].reg.code, o[1])])],
    LES: [rule(['r16', 'm'], (o) => [0xC4, ...modrm(o[0].reg.code, o[1])])],
    PUSH: [
        rule(['r16'], (o) => [0x50 + o[0].reg.code]),
        rule(['sreg'], (o) => [0x06 + (o[0].reg.code << 3)]),
        rule(['m16'], (o) => [0xFF, ...modrm(6, o[0])]),
        rule(['imm'], (o, c) => (fitsS8(o[0]) ? [0x6A, ...ib(o[0], c)] : [0x68, ...iw(o[0], c)]), { cpu: '186' }),
    ],
    POP: [
        rule(['r16'], (o) => [0x58 + o[0].reg.code]),
        rule(['sreg'], (o) => {
            if (o[0].reg.name === 'CS') throw new Error('Cannot POP into CS');
            return [0x07 + (o[0].reg.code << 3)];
        }),
        rule(['m16'], (o) => [0x8F, ...modrm(0, o[0])]),
    ],
    IN: [
        rule(['al', 'imm'], (o, c) => [0xE4, ...ib(o[1], c)]),
        rule(['ax', 'imm'], (o, c) => [0xE5, ...ib(o[1], c)]),
        rule(['al', 'dx'], () => [0xEC]),
        rule(['ax', 'dx'], () => [0xED]),
    ],
    OUT: [
        rule(['imm', 'al'], (o, c) => [0xE6, ...ib(o[0], c)]),
        rule(['imm', 'ax'], (o, c) => [0xE7, ...ib(o[0], c)]),
        rule(['dx', 'al'], () => [0xEE]),
        rule(['dx', 'ax'], () => [0xEF]),
    ],

    // --- control transfer
    JMP: [
        rule(['farptr'], (o) => [0xEA, ...le16(o[0].off.value), ...le16(o[0].seg.value)]),
        rule(['m32'], (o) => [0xFF, ...modrm(5, o[0])]),
        rule(['rm16'], (o) => [0xFF, ...modrm(4, o[0])]),
        // Short (EB) by default; the driver promotes it to near (E9) when the target is out of range.
        rule(['imm'], (o, c) => (c.long
            ? [0xE9, ...le16(o[0].value - (c.offset + 3))]
            : [0xEB, rel8(o[0].value, c, 2)]), { relax: true, size: (o, c) => (c.long ? 3 : 2) }),
    ],
    CALL: [
        rule(['farptr'], (o) => [0x9A, ...le16(o[0].off.value), ...le16(o[0].seg.value)]),
        rule(['m32'], (o) => [0xFF, ...modrm(3, o[0])]),
        rule(['rm16'], (o) => [0xFF, ...modrm(2, o[0])]),
        rule(['imm'], (o, c) => [0xE8, ...le16(o[0].value - (c.offset + 3))], { size: () => 3 }),
    ],
    JE: condJump(0x74), JZ: condJump(0x74), JNE: condJump(0x75), JNZ: condJump(0x75),
    JA: condJump(0x77), JNBE: condJump(0x77), JAE: condJump(0x73), JNB: condJump(0x73), JNC: condJump(0x73),
    JB: condJump(0x72), JNAE: condJump(0x72), JC: condJump(0x72), JBE: condJump(0x76), JNA: condJump(0x76),
    JG: condJump(0x7F), JNLE: condJump(0x7F), JGE: condJump(0x7D), JNL: condJump(0x7D),
    JL: condJump(0x7C), JNGE: condJump(0x7C), JLE: condJump(0x7E), JNG: condJump(0x7E),
    JO: condJump(0x70), JNO: condJump(0x71), JS: condJump(0x78), JNS: condJump(0x79),
    JP: condJump(0x7A), JPE: condJump(0x7A), JNP: condJump(0x7B), JPO: condJump(0x7B),
    LOOP: condJump(0xE2), LOOPE: condJump(0xE1), LOOPZ: condJump(0xE1),
    LOOPNE: condJump(0xE0), LOOPNZ: condJump(0xE0), JCXZ: condJump(0xE3),
};

/** Mnemonics that exist on real x86 CPUs but that this assembler does not implement. */
export const UNSUPPORTED_MNEMONICS = new Set([
    // 80286+ system / protected-mode
    'LGDT', 'LIDT', 'LLDT', 'LTR', 'SGDT', 'SIDT', 'SLDT', 'STR', 'LMSW', 'SMSW', 'LAR', 'LSL', 'VERR', 'VERW', 'ARPL', 'CLTS',
    // 80386+
    'MOVZX', 'MOVSX', 'BSF', 'BSR', 'BT', 'BTC', 'BTR', 'BTS', 'SHLD', 'SHRD', 'LFS', 'LGS', 'LSS', 'CWDE', 'CDQ',
    'PUSHAD', 'POPAD', 'PUSHFD', 'POPFD', 'JECXZ', 'SETA', 'SETE', 'SETNE', 'SETZ', 'SETC', 'SETNC', 'IRETD',
    // 80486+ / Pentium+
    'CMPXCHG', 'XADD', 'BSWAP', 'INVD', 'WBINVD', 'INVLPG', 'CPUID', 'RDTSC', 'RDMSR', 'WRMSR', 'UD2', 'CMOVE', 'CMOVNE',
    // x87 FPU
    'FLD', 'FST', 'FSTP', 'FILD', 'FIST', 'FISTP', 'FADD', 'FSUB', 'FMUL', 'FDIV', 'FCOM', 'FCOMP', 'FXCH', 'FCHS', 'FABS',
    'FSQRT', 'FLDZ', 'FLD1', 'FINIT', 'FNINIT', 'FSTSW', 'FNSTSW', 'FSTCW', 'FLDCW', 'FCLEX',
    // misc 8086 spellings not implemented
    'MOVS', 'CMPS', 'SCAS', 'LODS', 'STOS', 'INS', 'OUTS', 'ICEBP', 'INT1', 'IRETW', 'PUSHFW', 'POPFW',
]);

export const hasInstruction = (name) => Object.prototype.hasOwnProperty.call(INSTRUCTIONS, name);
export const isRelaxableJump = (rule) => !!rule.relax;

/**
 * Pick the rule for a mnemonic + operands.
 * @returns {object|null} the rule, or null if the mnemonic has no rule for these operands
 * @throws on CPU-gated instructions and on unsized-memory ambiguity
 */
export const findRule = (mnemonic, operands, cpu) => {
    const rules = INSTRUCTIONS[mnemonic];
    if (!rules) return null;
    const matched = rules.filter((r) => r.match.length === operands.length
        && r.match.every((cls, i) => CLASS_TEST[cls](operands[i])));
    if (matched.length === 0) return null;

    const level = CPU_LEVEL[cpu];
    const allowed = matched.filter((r) => CPU_LEVEL[r.cpu ?? '8086'] <= level);
    if (allowed.length === 0) {
        throw new Error(`${mnemonic} with these operands is not available on the 8086 (use "cpu ${matched[0].cpu}" to enable it)`);
    }

    const memIdx = operands.findIndex((o) => o.type === 'mem' && o.mem.size === null);
    if (memIdx >= 0) {
        const sizes = new Set(allowed.map((r) => CLASS_MEM_SIZE[r.match[memIdx]]).filter((s) => s !== null && s !== undefined));
        if (sizes.size > 1) throw new Error(`operation size not specified for ${mnemonic} (add BYTE or WORD)`);
    }
    return allowed.find((r) => r.prefer) ?? allowed[0];
};

/** Encoded length of a rule for the given operands (derived from enc unless the rule fixes it). */
export const ruleSize = (rule, operands, ctx) => (rule.size
    ? rule.size(operands, ctx)
    : rule.enc(operands, { ...ctx, sizing: true, warn: () => {} }).length);

export { le16, le32 };
