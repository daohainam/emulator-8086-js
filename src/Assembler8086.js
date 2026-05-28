/**
 * 8086 Assembler - NASM-Compatible Version (Vanilla JavaScript)
 * Two-pass assembler with preprocessor support.
 * Features: EQU, expressions with $ and $$, local labels, %define,
 * SECTION/BITS directives, RESB/RESW/RESD, DD, ALIGN,
 * near/short JMP, binary/octal literals, multi-char literals,
 * TIMES with any instruction, sign-extended immediates.
 */

const MAX_ASSEMBLY_ATTEMPTS = 5;
const NOP_OPCODE = 0x90;

const REGISTERS = {
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

const OpType = { 
    REG8: 'REG8', REG16: 'REG16', SEG_REG: 'SEG_REG', 
    NUMBER: 'NUMBER', LABEL: 'LABEL', 
    MEM_ANY: 'MEM_ANY', MEM8: 'MEM8', MEM16: 'MEM16', NONE: 'NONE' 
};

const encodeModRM = (mod, reg, rm) => ((mod & 0b11) << 6) | ((reg & 0b111) << 3) | (rm & 0b111);
const imm16ToBytes = (imm) => [imm & 0xFF, (imm >> 8) & 0xFF];
const imm32ToBytes = (imm) => [imm & 0xFF, (imm >> 8) & 0xFF, (imm >> 16) & 0xFF, (imm >> 24) & 0xFF];

function createAluRules(opcodeBase, extension) {
    return [
        { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => [opcodeBase + 0x02, encodeModRM(0b11, ops[0].reg.code, ops[1].reg.code)] },
        { match: [OpType.REG8, OpType.MEM8], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x02, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; } },
        { match: [OpType.REG16, OpType.REG16], size: () => 2, encode: (ops) => [opcodeBase + 0x03, encodeModRM(0b11, ops[0].reg.code, ops[1].reg.code)] },
        { match: [OpType.REG16, OpType.MEM16], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x03, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; } },
        { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x00, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.MEM16, OpType.REG16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x01, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.REG8, OpType.NUMBER], size: (ops) => ops[0].reg.name === 'AL' ? 2 : 3, encode: (ops) => { if (ops[0].reg.name === 'AL') return [opcodeBase + 0x04, ops[1].value & 0xFF]; return [0x80, encodeModRM(0b11, extension, ops[0].reg.code), ops[1].value & 0xFF]; } },
        // REG16, imm — use sign-extended form (0x83) when possible for non-AX
        { match: [OpType.REG16, OpType.NUMBER], size: (ops) => {
            if (ops[0].reg.name === 'AX') return 3;
            const v = ops[1].value;
            if (v >= -128 && v <= 127 && extension !== 1 /* OR cannot use 0x83 on 8086 — actually it can */) return 3;
            return 4;
        }, encode: (ops) => {
            if (ops[0].reg.name === 'AX') return [opcodeBase + 0x05, ...imm16ToBytes(ops[1].value)];
            const v = ops[1].value;
            if (v >= -128 && v <= 127) return [0x83, encodeModRM(0b11, extension, ops[0].reg.code), v & 0xFF];
            return [0x81, encodeModRM(0b11, extension, ops[0].reg.code), ...imm16ToBytes(ops[1].value)];
        } },
        { match: [OpType.MEM8, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize + 1, encode: (ops) => { const bytes = [0x80, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); bytes.push(ops[1].value & 0xFF); return bytes; } },
        // MEM16, imm — use sign-extended form (0x83) when possible
        { match: [OpType.MEM16, OpType.NUMBER], size: (ops) => {
            const v = ops[1].value;
            if (v >= -128 && v <= 127) return 2 + ops[0].mem.dispSize + 1;
            return 2 + ops[0].mem.dispSize + 2;
        }, encode: (ops) => {
            const v = ops[1].value;
            if (v >= -128 && v <= 127) {
                const bytes = [0x83, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)];
                if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue));
                bytes.push(v & 0xFF); return bytes;
            }
            const bytes = [0x81, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)];
            if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue));
            bytes.push(...imm16ToBytes(ops[1].value)); return bytes;
        } }
    ];
}

function createMulDivRules(extension) { return [ { match: [OpType.REG8], size: () => 2, encode: (ops) => [0xF6, encodeModRM(0b11, extension, ops[0].reg.code)] }, { match: [OpType.REG16], size: () => 2, encode: (ops) => [0xF7, encodeModRM(0b11, extension, ops[0].reg.code)] }, { match: [OpType.MEM8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xF6, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } }, { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xF7, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } } ]; }
function createNotNegRules(extension) { return createMulDivRules(extension); }

// JMP uses short (2 bytes) by default; assembler will auto-retry with near if needed
function createJmpShortRule(opcode) {
    return { match: [OpType.LABEL], size: () => 2, encode: (ops, offset, symbols) => {
        const label = ops[0].value;
        const targetOffset = symbols.get(label);
        if (targetOffset === undefined) throw new Error(`Label not found: ${label}`);
        const relOffset = targetOffset - (offset + 2);
        if (relOffset < -128 || relOffset > 127) throw new Error(`__NEED_NEAR_JMP__${label}`);
        return [opcode, relOffset < 0 ? 0x100 + relOffset : relOffset];
    }};
}
function createJmpShortNumRule(opcode) {
    return { match: [OpType.NUMBER], size: () => 2, encode: (ops, offset) => {
        const relOffset = ops[0].value - (offset + 2);
        if (relOffset < -128 || relOffset > 127) {
            // For NUMBER operand (e.g. jmp $), this should never need near for self-references
            throw new Error(`Jump distance exceeds 8-bit limit (distance: ${relOffset}). Use JMP NEAR.`);
        }
        return [opcode, relOffset < 0 ? 0x100 + relOffset : relOffset];
    }};
}

// Conditional jump: short only (8086)
function createCondJmpRule(opcode) {
    return [
        { match: [OpType.LABEL], size: () => 2, encode: (ops, offset, symbols) => {
            const label = ops[0].value;
            const targetOffset = symbols.get(label);
            if (targetOffset === undefined) throw new Error(`Label not found: ${label}`);
            const relOffset = targetOffset - (offset + 2);
            if (relOffset < -128 || relOffset > 127) throw new Error(`Conditional jump out of range for '${label}' (distance: ${relOffset}). 8086 conditional jumps are limited to ±127 bytes.`);
            return [opcode, relOffset < 0 ? 0x100 + relOffset : relOffset];
        }},
        { match: [OpType.NUMBER], size: () => 2, encode: (ops, offset) => {
            const relOffset = ops[0].value - (offset + 2);
            if (relOffset < -128 || relOffset > 127) throw new Error(`Conditional jump distance exceeds 8-bit limit (distance: ${relOffset}).`);
            return [opcode, relOffset < 0 ? 0x100 + relOffset : relOffset];
        }}
    ];
}

function createShiftRules(extension) { return [ { match: [OpType.REG8, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[1].value !== 1) throw new Error("8086 only supports shift by 1 or CL."); return [0xD0, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM8, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].value !== 1) throw new Error("8086 only supports shift by 1 or CL."); const bytes = [0xD0, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}, { match: [OpType.REG16, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[1].value !== 1) throw new Error("8086 only supports shift by 1 or CL."); return [0xD1, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM16, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].value !== 1) throw new Error("8086 only supports shift by 1 or CL."); const bytes = [0xD1, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}, { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); return [0xD2, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); const bytes = [0xD2, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}, { match: [OpType.REG16, OpType.REG8], size: () => 2, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); return [0xD3, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM16, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); const bytes = [0xD3, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }} ]; }


const OPCODE_TABLE = {
    'HLT': [{ match: [], size: () => 1, encode: () => [0xF4] }], 'NOP': [{ match: [], size: () => 1, encode: () => [0x90] }], 
    'WAIT':  [{ match: [], size: () => 1, encode: () => [0x9B] }], 'LOCK':  [{ match: [], size: () => 1, encode: () => [0xF0] }],
    
    'REP':   [{ match: [], size: () => 1, encode: () => [0xF3] }], 'REPE':  [{ match: [], size: () => 1, encode: () => [0xF3] }],
    'REPZ':  [{ match: [], size: () => 1, encode: () => [0xF3] }], 'REPNE': [{ match: [], size: () => 1, encode: () => [0xF2] }],
    'REPNZ': [{ match: [], size: () => 1, encode: () => [0xF2] }],

    'INT': [ { match: [OpType.NUMBER], size: (ops) => (ops[0].value === 3) ? 1 : 2, encode: (ops) => { if (ops[0].value === 3) return [0xCC]; return [0xCD, ops[0].value & 0xFF]; } } ],
    'INTO': [{ match: [], size: () => 1, encode: () => [0xCE] }], 'IRET': [{ match: [], size: () => 1, encode: () => [0xCF] }],
    'RET': [ { match: [], size: () => 1, encode: () => [0xC3] }, { match: [OpType.NUMBER], size: () => 3, encode: (ops) => [0xC2, ...imm16ToBytes(ops[0].value)] } ],
    'RETF': [ { match: [], size: () => 1, encode: () => [0xCB] }, { match: [OpType.NUMBER], size: () => 3, encode: (ops) => [0xCA, ...imm16ToBytes(ops[0].value)] } ],
    
    'CALL': [
        { match: [OpType.LABEL], size: () => 3, encode: (ops, offset, symbols) => { const label = ops[0].value; const targetOffset = symbols.get(label); if (targetOffset === undefined) throw new Error(`Label error: ${label}`); const relOffset = targetOffset - (offset + 3); return [0xE8, ...imm16ToBytes(relOffset)]; } },
        { match: [OpType.NUMBER], size: () => 3, encode: (ops, offset) => { const relOffset = ops[0].value - (offset + 3); return [0xE8, ...imm16ToBytes(relOffset)]; } },
        { match: [OpType.REG16], size: () => 2, encode: (ops) => [0xFF, encodeModRM(0b11, 2, ops[0].reg.code)] },
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 2, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }},
        { match: [OpType.MEM_ANY], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 2, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],

    'ADD': createAluRules(0x00, 0), 'OR':  createAluRules(0x08, 1), 'ADC': createAluRules(0x10, 2), 'SBB': createAluRules(0x18, 3),
    'AND': createAluRules(0x20, 4), 'SUB': createAluRules(0x28, 5), 'XOR': createAluRules(0x30, 6), 'CMP': createAluRules(0x38, 7),
    'MUL': createMulDivRules(4), 'IMUL': createMulDivRules(5), 'DIV': createMulDivRules(6), 'IDIV': createMulDivRules(7),
    'NOT': createNotNegRules(2), 'NEG': createNotNegRules(3),

    'DAA': [{ match: [], size: () => 1, encode: () => [0x27] }], 'DAS': [{ match: [], size: () => 1, encode: () => [0x2F] }],
    'AAA': [{ match: [], size: () => 1, encode: () => [0x37] }], 'AAS': [{ match: [], size: () => 1, encode: () => [0x3F] }],
    'AAM': [{ match: [], size: () => 2, encode: () => [0xD4, 0x0A] }], 'AAD': [{ match: [], size: () => 2, encode: () => [0xD5, 0x0A] }],

    'INC': [
        { match: [OpType.REG16], size: () => 1, encode: (ops) => [0x40 + ops[0].reg.code] },
        { match: [OpType.REG8], size: () => 2, encode: (ops) => [0xFE, encodeModRM(0b11, 0, ops[0].reg.code)] },
        { match: [OpType.MEM8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFE, encodeModRM(ops[0].mem.mod, 0, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }},
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 0, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],
    'DEC': [
        { match: [OpType.REG16], size: () => 1, encode: (ops) => [0x48 + ops[0].reg.code] },
        { match: [OpType.REG8], size: () => 2, encode: (ops) => [0xFE, encodeModRM(0b11, 1, ops[0].reg.code)] },
        { match: [OpType.MEM8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFE, encodeModRM(ops[0].mem.mod, 1, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }},
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 1, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],

    'ROL': createShiftRules(0), 'ROR': createShiftRules(1), 'RCL': createShiftRules(2), 'RCR': createShiftRules(3),
    'SHL': createShiftRules(4), 'SAL': createShiftRules(4), 'SHR': createShiftRules(5), 'SAR': createShiftRules(7),

    'TEST': [
        { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => [0x84, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)] },
        { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x84, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.REG16, OpType.REG16], size: () => 2, encode: (ops) => [0x85, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)] },
        { match: [OpType.MEM16, OpType.REG16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x85, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        // Fix #20: correct size for TEST reg, imm (non-AL/AX)
        { match: [OpType.REG8, OpType.NUMBER], size: (ops) => ops[0].reg.name === 'AL' ? 2 : 3, encode: (ops) => { if (ops[0].reg.name === 'AL') return [0xA8, ops[1].value & 0xFF]; return [0xF6, encodeModRM(0b11, 0, ops[0].reg.code), ops[1].value & 0xFF]; }},
        { match: [OpType.REG16, OpType.NUMBER], size: (ops) => ops[0].reg.name === 'AX' ? 3 : 4, encode: (ops) => { if (ops[0].reg.name === 'AX') return [0xA9, ...imm16ToBytes(ops[1].value)]; return [0xF7, encodeModRM(0b11, 0, ops[0].reg.code), ...imm16ToBytes(ops[1].value)]; }},
        { match: [OpType.MEM8, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize + 1, encode: (ops) => { const bytes = [0xF6, encodeModRM(ops[0].mem.mod, 0, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); bytes.push(ops[1].value & 0xFF); return bytes; }},
        { match: [OpType.MEM16, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize + 2, encode: (ops) => { const bytes = [0xF7, encodeModRM(ops[0].mem.mod, 0, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); bytes.push(...imm16ToBytes(ops[1].value)); return bytes; }}
    ],

    'LEA': [
        { match: [OpType.REG16, OpType.MEM_ANY], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x8D, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }},
        { match: [OpType.REG16, OpType.MEM16], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x8D, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }},
        { match: [OpType.REG16, OpType.MEM8], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x8D, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }},
        { match: [OpType.REG16, OpType.LABEL], size: () => 4, encode: (ops, offset, symbols) => { const target = symbols.get(ops[1].value); if (target === undefined) throw new Error(`Label error: ${ops[1].value}`); return [0x8D, encodeModRM(0b00, ops[0].reg.code, 0b110), ...imm16ToBytes(target)]; }}
    ],
    'LDS': [{ match: [OpType.REG16, OpType.MEM_ANY], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0xC5, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }}],
    'LES': [{ match: [OpType.REG16, OpType.MEM_ANY], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0xC4, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }}],
    'XLAT':  [{ match: [], size: () => 1, encode: () => [0xD7] }], 'XLATB': [{ match: [], size: () => 1, encode: () => [0xD7] }],

    // Fix #19: XCHG AX,reg16 size is conditionally 1 or 2
    'XCHG': [
        { match: [OpType.REG16, OpType.REG16], size: (ops) => (ops[0].reg.name === 'AX' || ops[1].reg.name === 'AX') ? 1 : 2, encode: (ops) => { if (ops[0].reg.name === 'AX') return [0x90 + ops[1].reg.code]; if (ops[1].reg.name === 'AX') return [0x90 + ops[0].reg.code]; return [0x87, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)]; }},
        { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => [0x86, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)] },
        { match: [OpType.REG8, OpType.MEM8], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x86, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }},
        { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x86, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }},
        { match: [OpType.REG16, OpType.MEM16], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x87, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; }},
        { match: [OpType.MEM16, OpType.REG16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x87, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],

    'IN': [
        { match: [OpType.REG8, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[0].reg.name !== 'AL') throw new Error("IN: Destination must be AL"); return [0xE4, ops[1].value & 0xFF]; }},
        { match: [OpType.REG16, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[0].reg.name !== 'AX') throw new Error("IN: Destination must be AX"); return [0xE5, ops[1].value & 0xFF]; }},
        { match: [OpType.REG8, OpType.REG16], size: () => 1, encode: (ops) => { if (ops[0].reg.name !== 'AL' || ops[1].reg.name !== 'DX') throw new Error("IN: Syntax must be IN AL, DX"); return [0xEC]; }},
        { match: [OpType.REG16, OpType.REG16], size: () => 1, encode: (ops) => { if (ops[0].reg.name !== 'AX' || ops[1].reg.name !== 'DX') throw new Error("IN: Syntax must be IN AX, DX"); return [0xED]; }}
    ],
    'OUT': [
        { match: [OpType.NUMBER, OpType.REG8], size: () => 2, encode: (ops) => { if (ops[1].reg.name !== 'AL') throw new Error("OUT: Source must be AL"); return [0xE6, ops[0].value & 0xFF]; }},
        { match: [OpType.NUMBER, OpType.REG16], size: () => 2, encode: (ops) => { if (ops[1].reg.name !== 'AX') throw new Error("OUT: Source must be AX"); return [0xE7, ops[0].value & 0xFF]; }},
        { match: [OpType.REG16, OpType.REG8], size: () => 1, encode: (ops) => { if (ops[0].reg.name !== 'DX' || ops[1].reg.name !== 'AL') throw new Error("OUT: Syntax must be OUT DX, AL"); return [0xEE]; }},
        { match: [OpType.REG16, OpType.REG16], size: () => 1, encode: (ops) => { if (ops[0].reg.name !== 'DX' || ops[1].reg.name !== 'AX') throw new Error("OUT: Syntax must be OUT DX, AX"); return [0xEF]; }}
    ],

    'PUSH': [
        { match: [OpType.REG16], size: () => 1, encode: (ops) => [0x50 + ops[0].reg.code] },
        { match: [OpType.SEG_REG], size: () => 1, encode: (ops) => [0x06 + (ops[0].reg.code << 3)] },
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 6, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],
    'POP': [
        { match: [OpType.REG16], size: () => 1, encode: (ops) => [0x58 + ops[0].reg.code] },
        { match: [OpType.SEG_REG], size: () => 1, encode: (ops) => { if (ops[0].reg.name === 'CS') throw new Error("Cannot POP into CS."); return [0x07 + (ops[0].reg.code << 3)]; }},
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x8F, encodeModRM(ops[0].mem.mod, 0, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],
    'PUSHA': [{ match: [], size: () => 1, encode: () => [0x60] }], 'POPA':  [{ match: [], size: () => 1, encode: () => [0x61] }],

    'MOV': [
        { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => [0x88, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)] },
        { match: [OpType.REG16, OpType.REG16], size: () => 2, encode: (ops) => [0x89, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)] },
        { match: [OpType.REG8, OpType.NUMBER], size: () => 2, encode: (ops) => [0xB0 + ops[0].reg.code, ops[1].value & 0xFF] },
        { match: [OpType.REG16, OpType.NUMBER], size: () => 3, encode: (ops) => [0xB8 + ops[0].reg.code, ...imm16ToBytes(ops[1].value)] },
        { match: [OpType.REG16, OpType.MEM16], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const reg = ops[0].reg; const mem = ops[1].mem; const bytes = [0x8B, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.MEM16, OpType.REG16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const mem = ops[0].mem; const reg = ops[1].reg; const bytes = [0x89, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.REG8, OpType.MEM8], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const reg = ops[0].reg; const mem = ops[1].mem; const bytes = [0x8A, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const mem = ops[0].mem; const reg = ops[1].reg; const bytes = [0x88, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.SEG_REG, OpType.REG16], size: () => 2, encode: (ops) => [0x8E, encodeModRM(0b11, ops[0].reg.code, ops[1].reg.code)] },
        { match: [OpType.SEG_REG, OpType.MEM16], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x8E, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; } },
        { match: [OpType.SEG_REG, OpType.MEM_ANY], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [0x8E, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; } },
        { match: [OpType.REG16, OpType.SEG_REG], size: () => 2, encode: (ops) => [0x8C, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)] },
        { match: [OpType.MEM16, OpType.SEG_REG], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x8C, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.MEM_ANY, OpType.SEG_REG], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0x8C, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.MEM8, OpType.NUMBER], size: (ops) => 3 + ops[0].mem.dispSize, encode: (ops) => { const mem = ops[0].mem; const bytes = [0xC6, encodeModRM(mem.mod, 0, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); bytes.push(ops[1].value & 0xFF); return bytes; } },
        { match: [OpType.MEM16, OpType.NUMBER], size: (ops) => 4 + ops[0].mem.dispSize, encode: (ops) => { const mem = ops[0].mem; const bytes = [0xC7, encodeModRM(mem.mod, 0, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); bytes.push(...imm16ToBytes(ops[1].value)); return bytes; } },
        { match: [OpType.REG16, OpType.LABEL], size: () => 3, encode: (ops, offset, symbols) => { const target = symbols.get(ops[1].value); if (target === undefined) throw new Error(`Label error: ${ops[1].value}`); return [0xB8 + ops[0].reg.code, ...imm16ToBytes(target)]; }},
        { match: [OpType.REG16, OpType.MEM_ANY], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const reg = ops[0].reg; const mem = ops[1].mem; const bytes = [0x8B, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.MEM_ANY, OpType.REG16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const mem = ops[0].mem; const reg = ops[1].reg; const bytes = [0x89, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.REG8, OpType.MEM_ANY], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const reg = ops[0].reg; const mem = ops[1].mem; const bytes = [0x8A, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } },
        { match: [OpType.MEM_ANY, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const mem = ops[0].mem; const reg = ops[1].reg; const bytes = [0x88, encodeModRM(mem.mod, reg.code, mem.rm)]; if (mem.dispSize === 1) bytes.push(mem.dispValue & 0xFF); else if (mem.dispSize === 2) bytes.push(...imm16ToBytes(mem.dispValue)); return bytes; } }
    ],

    'CLC': [{ match: [], size: () => 1, encode: () => [0xF8] }], 'STC': [{ match: [], size: () => 1, encode: () => [0xF9] }],
    'CMC': [{ match: [], size: () => 1, encode: () => [0xF5] }], 'CLI': [{ match: [], size: () => 1, encode: () => [0xFA] }],
    'STI': [{ match: [], size: () => 1, encode: () => [0xFB] }], 'LAHF': [{ match: [], size: () => 1, encode: () => [0x9F] }],
    'SAHF': [{ match: [], size: () => 1, encode: () => [0x9E] }], 'PUSHF': [{ match: [], size: () => 1, encode: () => [0x9C] }],
    'POPF': [{ match: [], size: () => 1, encode: () => [0x9D] }], 'CBW': [{ match: [], size: () => 1, encode: () => [0x98] }],
    'CWD': [{ match: [], size: () => 1, encode: () => [0x99] }],

    'LODSB': [{ match: [], size: () => 1, encode: () => [0xAC] }], 'LODSW': [{ match: [], size: () => 1, encode: () => [0xAD] }],
    'STOSB': [{ match: [], size: () => 1, encode: () => [0xAA] }], 'STOSW': [{ match: [], size: () => 1, encode: () => [0xAB] }],
    'MOVSB': [{ match: [], size: () => 1, encode: () => [0xA4] }], 'MOVSW': [{ match: [], size: () => 1, encode: () => [0xA5] }],
    'SCASB': [{ match: [], size: () => 1, encode: () => [0xAE] }], 'SCASW': [{ match: [], size: () => 1, encode: () => [0xAF] }],
    'CMPSB': [{ match: [], size: () => 1, encode: () => [0xA6] }], 'CMPSW': [{ match: [], size: () => 1, encode: () => [0xA7] }],
    'INSB':  [{ match: [], size: () => 1, encode: () => [0x6C] }], 'INSW':  [{ match: [], size: () => 1, encode: () => [0x6D] }],
    'OUTSB': [{ match: [], size: () => 1, encode: () => [0x6E] }], 'OUTSW': [{ match: [], size: () => 1, encode: () => [0x6F] }],
    'CLD': [{ match: [], size: () => 1, encode: () => [0xFC] }], 'STD': [{ match: [], size: () => 1, encode: () => [0xFD] }],

    // JMP: short (2 bytes, 0xEB) by default; near (3 bytes, 0xE9) auto-selected if short doesn't fit
    'JMP': [
        createJmpShortRule(0xEB),
        createJmpShortNumRule(0xEB),
        // Near JMP via label (3 bytes) — used by auto-retry mechanism
        { match: [OpType.LABEL], size: () => 3, encode: (ops, offset, symbols) => {
            const label = ops[0].value;
            const targetOffset = symbols.get(label);
            if (targetOffset === undefined) throw new Error(`Label not found: ${label}`);
            const nearRel = targetOffset - (offset + 3);
            return [0xE9, ...imm16ToBytes(nearRel)];
        }, _isNear: true },
        // Near JMP via number
        { match: [OpType.NUMBER], size: () => 3, encode: (ops, offset) => {
            const nearRel = ops[0].value - (offset + 3);
            return [0xE9, ...imm16ToBytes(nearRel)];
        }, _isNear: true },
        { match: [OpType.REG16], size: () => 2, encode: (ops) => [0xFF, encodeModRM(0b11, 4, ops[0].reg.code)] },
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 4, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }},
        { match: [OpType.MEM_ANY], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 4, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
    ],
    'JE':   createCondJmpRule(0x74), 'JZ':   createCondJmpRule(0x74), 'JNE':  createCondJmpRule(0x75), 'JNZ':  createCondJmpRule(0x75), 
    'JA':   createCondJmpRule(0x77), 'JNBE': createCondJmpRule(0x77), 'JAE':  createCondJmpRule(0x73), 'JNB':  createCondJmpRule(0x73), 'JNC':  createCondJmpRule(0x73),
    'JB':   createCondJmpRule(0x72), 'JNAE': createCondJmpRule(0x72), 'JC':   createCondJmpRule(0x72), 'JBE':  createCondJmpRule(0x76), 'JNA':  createCondJmpRule(0x76),
    'JG':   createCondJmpRule(0x7F), 'JNLE': createCondJmpRule(0x7F), 'JGE':  createCondJmpRule(0x7D), 'JNL':  createCondJmpRule(0x7D),
    'JL':   createCondJmpRule(0x7C), 'JNGE': createCondJmpRule(0x7C), 'JLE':  createCondJmpRule(0x7E), 'JNG':  createCondJmpRule(0x7E),
    'JO':   createCondJmpRule(0x70), 'JNO':  createCondJmpRule(0x71), 'JS':   createCondJmpRule(0x78), 'JNS':  createCondJmpRule(0x79),
    'JP':   createCondJmpRule(0x7A), 'JPE':  createCondJmpRule(0x7A), 'JNP':  createCondJmpRule(0x7B), 'JPO':  createCondJmpRule(0x7B),

    'LOOP':   createCondJmpRule(0xE2), 'LOOPE':  createCondJmpRule(0xE1), 'LOOPZ':  createCondJmpRule(0xE1),
    'LOOPNE': createCondJmpRule(0xE0), 'LOOPNZ': createCondJmpRule(0xE0), 'JCXZ':   createCondJmpRule(0xE3)
};

// Directives recognized by the assembler (not in OPCODE_TABLE but handled specially)
const DIRECTIVES = ['ORG', '.ORG', 'DB', 'DW', 'DD', 'TIMES', 'EQU', 'RESB', 'RESW', 'RESD', 'ALIGN',
    'SECTION', 'SEGMENT', 'BITS', 'GLOBAL', 'EXTERN', 'CPU'];

class Assembler8086 {
    constructor() {
        this.symbolTable = new Map();
        this.lines = [];
        this.defines = new Map();
        this.currentGlobalLabel = '';
        this.sectionBase = 0;
    }

    assemble(sourceCode) {
        this.symbolTable.clear();
        this.lines = [];
        this.defines = new Map();
        this.currentGlobalLabel = '';
        this.sectionBase = 0;

        // Preprocessor pass: handle %define
        const preprocessed = this.preprocess(sourceCode);
        
        // Try assembly with short jumps first; auto-upgrade to near if needed
        for (let attempt = 0; attempt < MAX_ASSEMBLY_ATTEMPTS; attempt++) {
            this.symbolTable.clear();
            this.lines = [];
            this.currentGlobalLabel = '';
            this.sectionBase = 0;
            this.pass1(preprocessed);
            
            try {
                return this.pass2();
            } catch (err) {
                // Check if error is due to a short JMP that needs to be near
                const match = err.message.match(/__NEED_NEAR_JMP__(.+?)(?:"|$)/);
                if (match) {
                    // Mark this label as needing a near jump and retry
                    if (!this._nearJmpLabels) this._nearJmpLabels = new Set();
                    this._nearJmpLabels.add(match[1]);
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Assembly failed: could not resolve jump sizes after multiple attempts');
    }

    // Preprocessor: handle %define directives and perform text substitution
    preprocess(sourceCode) {
        const rawLines = sourceCode.split('\n');
        const outputLines = [];

        for (let i = 0; i < rawLines.length; i++) {
            let line = rawLines[i];
            const trimmed = line.trim();

            // Handle %define
            if (trimmed.toLowerCase().startsWith('%define')) {
                const rest = trimmed.substring(7).trim();
                const spaceIdx = rest.indexOf(' ');
                if (spaceIdx !== -1) {
                    const name = rest.substring(0, spaceIdx).trim();
                    const value = rest.substring(spaceIdx + 1).trim();
                    this.defines.set(name, value);
                    this.defines.set(name.toUpperCase(), value);
                } else {
                    // %define with no value — define as empty
                    this.defines.set(rest, '');
                    this.defines.set(rest.toUpperCase(), '');
                }
                outputLines.push(''); // preserve line numbers
                continue;
            }

            // Skip other preprocessor directives
            if (trimmed.startsWith('%')) {
                outputLines.push('');
                continue;
            }

            // Apply defines (simple word-boundary substitution)
            if (this.defines.size > 0) {
                for (const [name, value] of this.defines) {
                    if (line.includes(name)) {
                        // Replace whole words only
                        const regex = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
                        line = line.replace(regex, value);
                    }
                }
            }

            outputLines.push(line);
        }
        return outputLines.join('\n');
    }

    pass1(sourceCode) {
        const rawLines = sourceCode.split('\n');
        let currentAddress = 0;

        for (let i = 0; i < rawLines.length; i++) {
            let cleaned = rawLines[i].trim();
            if (!cleaned || cleaned.startsWith(';')) continue;

            // Handle bracketed directives: [ORG ...], [BITS 16], etc.
            if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
                const inner = cleaned.substring(1, cleaned.length - 1).trim();
                const upperInner = inner.toUpperCase();
                if (upperInner.startsWith('ORG')) {
                    cleaned = inner;
                } else if (upperInner.startsWith('BITS')) {
                    // Silently ignore [BITS 16]
                    continue;
                } else {
                    continue; // Ignore other bracketed directives
                }
            }
            
            // Strip comments (respecting quotes)
            let inStr = false;
            let commentIdx = -1;
            let quoteChar = '';
            for (let j = 0; j < cleaned.length; j++) {
                const char = cleaned[j];
                if (char === "'" || char === '"') {
                    if (!inStr) { inStr = true; quoteChar = char; }
                    else if (char === quoteChar) { inStr = false; }
                }
                if (char === ';' && !inStr) { commentIdx = j; break; }
            }
            if (commentIdx !== -1) cleaned = cleaned.substring(0, commentIdx).trim();
            if (!cleaned) continue;

            // Parse label (with colon)
            let label = null;
            const colonIdx = cleaned.indexOf(':');
            if (colonIdx !== -1 && !cleaned.substring(0, colonIdx).includes("'") && !cleaned.substring(0, colonIdx).includes('"')) {
                const beforeColon = cleaned.substring(0, colonIdx).trim();
                // Support local labels (.name) and regular labels
                if ((/^\.?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(beforeColon)) && !['ES','CS','SS','DS'].includes(beforeColon.toUpperCase())) {
                    label = beforeColon;
                    cleaned = cleaned.substring(colonIdx + 1).trim();
                }
            }
            // Label without colon (legacy NASM support) — only if token is not a known mnemonic/directive
            if (!label && cleaned) {
                const firstSpace = cleaned.indexOf(' ');
                const firstToken = firstSpace !== -1 ? cleaned.substring(0, firstSpace) : cleaned;
                const upperToken = firstToken.toUpperCase();
                if (!OPCODE_TABLE[upperToken] && !DIRECTIVES.includes(upperToken) && 
                    !['REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ', 'LOCK'].includes(upperToken)) {
                    // Check if next token is EQU
                    const afterToken = firstSpace !== -1 ? cleaned.substring(firstSpace + 1).trim() : '';
                    if (afterToken.toUpperCase().startsWith('EQU')) {
                        label = firstToken;
                        cleaned = afterToken;
                    } else if (/^\.?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(firstToken)) {
                        label = firstToken;
                        cleaned = cleaned.substring(firstToken.length).trim();
                    }
                }
            }

            // Resolve local label
            if (label) {
                if (label.startsWith('.')) {
                    // Local label: scope to current global label
                    label = this.currentGlobalLabel + label;
                } else {
                    // Update current global label
                    this.currentGlobalLabel = label.toUpperCase();
                }
                this.symbolTable.set(label.toUpperCase(), currentAddress);
            }
            if (!cleaned) continue;

            const firstSpace = cleaned.indexOf(' ');
            const mnemonic1 = firstSpace !== -1 ? cleaned.substring(0, firstSpace).toUpperCase() : cleaned.toUpperCase();
            let rest = firstSpace !== -1 ? cleaned.substring(firstSpace + 1).trim() : '';

            // Handle directives
            if (mnemonic1 === 'ORG' || mnemonic1 === '.ORG') {
                const newOrg = this.evaluateExpr(rest, currentAddress, this.sectionBase);
                if (isNaN(newOrg)) throw new Error(`[Line ${i+1}] Invalid ORG operand: ${rest}`);
                currentAddress = newOrg;
                this.sectionBase = newOrg;
                continue;
            }

            if (mnemonic1 === 'EQU') {
                if (!label) throw new Error(`[Line ${i+1}] EQU requires a label`);
                const val = this.evaluateExpr(rest, currentAddress, this.sectionBase);
                if (isNaN(val)) throw new Error(`[Line ${i+1}] Invalid EQU expression: ${rest}`);
                this.symbolTable.set(label.toUpperCase(), val);
                continue;
            }

            // Ignore SECTION, SEGMENT, BITS, GLOBAL, EXTERN, CPU directives
            if (['SECTION', 'SEGMENT', 'BITS', 'GLOBAL', 'EXTERN', 'CPU'].includes(mnemonic1)) {
                continue;
            }

            if (mnemonic1 === 'ALIGN') {
                const alignment = this.evaluateExpr(rest, currentAddress, this.sectionBase);
                if (isNaN(alignment) || alignment <= 0) throw new Error(`[Line ${i+1}] Invalid ALIGN value: ${rest}`);
                const padding = (alignment - (currentAddress % alignment)) % alignment;
                if (padding > 0) {
                    const padBytes = new Array(padding).fill(NOP_OPCODE); // NOP padding
                    const parsedLine = { original: rawLines[i], label, mnemonic: 'ALIGN', operands: [], offset: currentAddress };
                    parsedLine.rule = { match: [], size: () => padBytes.length, encode: () => padBytes };
                    currentAddress += padBytes.length;
                    this.lines.push(parsedLine);
                }
                continue;
            }

            if (mnemonic1 === 'RESB' || mnemonic1 === 'RESW' || mnemonic1 === 'RESD') {
                const count = this.evaluateExpr(rest, currentAddress, this.sectionBase);
                if (isNaN(count) || count < 0) throw new Error(`[Line ${i+1}] Invalid ${mnemonic1} count: ${rest}`);
                const unitSize = mnemonic1 === 'RESB' ? 1 : mnemonic1 === 'RESW' ? 2 : 4;
                const totalBytes = count * unitSize;
                const zeros = new Array(totalBytes).fill(0);
                const parsedLine = { original: rawLines[i], label, mnemonic: mnemonic1, operands: [], offset: currentAddress };
                parsedLine.rule = { match: [], size: () => zeros.length, encode: () => zeros };
                currentAddress += totalBytes;
                this.lines.push(parsedLine);
                continue;
            }

            if (mnemonic1 === 'TIMES') {
                const [countExpr, subDirective] = this.splitTimesExpr(rest);
                const count = this.evaluateExpr(countExpr, currentAddress, this.sectionBase);
                if (isNaN(count) || count < 0) throw new Error(`[Line ${i+1}] Invalid TIMES count expression: ${countExpr}`);

                const subFirstSpace = subDirective.indexOf(' ');
                const subMnemonic = (subFirstSpace !== -1 ? subDirective.substring(0, subFirstSpace) : subDirective).toUpperCase();
                const subRest = subFirstSpace !== -1 ? subDirective.substring(subFirstSpace + 1).trim() : '';

                if (subMnemonic === 'DB' || subMnemonic === 'DW' || subMnemonic === 'DD') {
                    const unitBytes = this.parseDataDirectiveArgs(subMnemonic, subRest, currentAddress, i);
                    const repeatedBytes = [];
                    for (let t = 0; t < count; t++) repeatedBytes.push(...unitBytes);
                    const parsedLine = { original: rawLines[i], label, mnemonic: 'TIMES', operands: [], offset: currentAddress };
                    parsedLine.rule = { match: [], size: () => repeatedBytes.length, encode: () => repeatedBytes };
                    currentAddress += repeatedBytes.length;
                    this.lines.push(parsedLine);
                    continue;
                }

                // TIMES with any instruction (e.g., "times 3 nop")
                if (OPCODE_TABLE[subMnemonic]) {
                    const rawOperands = this.splitOperands(subRest);
                    const operands = rawOperands.map(op => this.parseOperand(op, currentAddress));
                    const rule = this.findMatchingRule(subMnemonic, operands);
                    if (!rule) throw new Error(`[Line ${i+1}] TIMES: unsupported instruction: ${subMnemonic} ${subRest}`);
                    const instrSize = rule.size(operands);
                    const prefixOp = operands.find(op => op.mem && op.mem.prefixByte);
                    const totalInstrSize = instrSize + (prefixOp ? 1 : 0);
                    
                    for (let t = 0; t < count; t++) {
                        const parsedLine = { original: rawLines[i], label: t === 0 ? label : null, mnemonic: subMnemonic, operands, offset: currentAddress, rule };
                        currentAddress += totalInstrSize;
                        this.lines.push(parsedLine);
                    }
                    continue;
                }
                throw new Error(`[Line ${i+1}] TIMES: unsupported sub-directive: ${subMnemonic}`);
            }

            if (mnemonic1 === 'DB' || mnemonic1 === 'DW' || mnemonic1 === 'DD') {
                // Fix #23: Defer label resolution to pass 2 for DW/DD
                const rawArgs = this.splitOperands(rest);
                const hasLabelRef = rawArgs.some(arg => {
                    const trimArg = arg.trim();
                    if ((trimArg.startsWith("'") && trimArg.endsWith("'")) || (trimArg.startsWith('"') && trimArg.endsWith('"'))) return false;
                    const num = this.parseNumber(trimArg);
                    if (!isNaN(num)) return false;
                    // Check if it's an expression with $ or known label
                    return true;
                });

                if (hasLabelRef && (mnemonic1 === 'DW' || mnemonic1 === 'DD')) {
                    // Deferred: compute size now, resolve values in pass 2
                    let totalSize = 0;
                    for (const arg of rawArgs) {
                        const trimArg = arg.trim();
                        if ((trimArg.startsWith("'") && trimArg.endsWith("'")) || (trimArg.startsWith('"') && trimArg.endsWith('"'))) {
                            const str = trimArg.slice(1, -1);
                            totalSize += str.length * (mnemonic1 === 'DW' ? 2 : 4);
                        } else {
                            totalSize += mnemonic1 === 'DW' ? 2 : 4;
                        }
                    }
                    const lineOffset = currentAddress;
                    const parsedLine = { original: rawLines[i], label, mnemonic: mnemonic1, operands: [], offset: lineOffset };
                    parsedLine.rule = { match: [], size: () => totalSize, encode: (ops, offset, symbols) => {
                        const bytes = [];
                        for (const arg of rawArgs) {
                            const trimArg = arg.trim();
                            if ((trimArg.startsWith("'") && trimArg.endsWith("'")) || (trimArg.startsWith('"') && trimArg.endsWith('"'))) {
                                const str = trimArg.slice(1, -1);
                                for (let j = 0; j < str.length; j++) {
                                    if (mnemonic1 === 'DW') bytes.push(...imm16ToBytes(str.charCodeAt(j)));
                                    else bytes.push(...imm32ToBytes(str.charCodeAt(j)));
                                }
                            } else {
                                const val = this.resolveExprWithSymbols(trimArg, lineOffset, this.sectionBase, symbols);
                                if (mnemonic1 === 'DW') bytes.push(...imm16ToBytes(val));
                                else bytes.push(...imm32ToBytes(val));
                            }
                        }
                        return bytes;
                    }};
                    currentAddress += totalSize;
                    this.lines.push(parsedLine);
                } else {
                    const bytes = this.parseDataDirectiveArgs(mnemonic1, rest, currentAddress, i);
                    const parsedLine = { original: rawLines[i], label, mnemonic: mnemonic1, operands: [], offset: currentAddress };
                    parsedLine.rule = { match: [], size: () => bytes.length, encode: () => bytes };
                    currentAddress += bytes.length;
                    this.lines.push(parsedLine);
                }
                continue;
            }

            const mnemonicsToProcess = [];
            const isPrefix = ['REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ', 'LOCK'].includes(mnemonic1);
            
            if (isPrefix && rest) {
                const secondSpace = rest.indexOf(' ');
                const mnemonic2 = secondSpace !== -1 ? rest.substring(0, secondSpace).toUpperCase() : rest.toUpperCase();
                const opsStr = secondSpace !== -1 ? rest.substring(secondSpace + 1).trim() : '';
                mnemonicsToProcess.push({ m: mnemonic1, ops: '' });
                mnemonicsToProcess.push({ m: mnemonic2, ops: opsStr });
            } else {
                mnemonicsToProcess.push({ m: mnemonic1, ops: rest });
            }

            for (const item of mnemonicsToProcess) {
                const parsedLine = { original: rawLines[i], label: null, mnemonic: item.m, operands: [], offset: currentAddress };
                const rawOperands = this.splitOperands(item.ops);
                parsedLine.operands = rawOperands.map(op => this.parseOperand(op, currentAddress));

                const rule = this.findMatchingRule(item.m, parsedLine.operands);
                if (!rule) throw new Error(`[Line ${i+1}] Unsupported opcode or syntax error: ${item.m} ${item.ops}`);
                
                parsedLine.rule = rule;
                
                let ruleSize = rule.size(parsedLine.operands);
                const prefixOp = parsedLine.operands.find(op => op.mem && op.mem.prefixByte);
                if (prefixOp) ruleSize += 1; 

                currentAddress += ruleSize;
                this.lines.push(parsedLine);
            }
        }
    }

    pass2() {
        const output = [];
        for (const line of this.lines) {
            if (!line.mnemonic || !line.rule) continue;
            try {
                let bytes = line.rule.encode(line.operands, line.offset, this.symbolTable);
                
                const prefixOp = line.operands.find(op => op.mem && op.mem.prefixByte);
                if (prefixOp && prefixOp.mem.prefixByte) {
                    bytes = [prefixOp.mem.prefixByte, ...bytes];
                }

                let expectedSize = line.rule.size(line.operands);
                if (prefixOp) expectedSize += 1;

                if (bytes.length !== expectedSize) {
                    throw new Error(`Size mismatch: Instruction ${line.mnemonic} expected ${expectedSize} bytes but generated ${bytes.length}.`);
                }
                output.push(...bytes);
            } catch (err) {
                throw new Error(`[Pass 2] Error at line "${line.original.trim()}": ${err.message}`);
            }
        }
        return new Uint8Array(output);
    }

    // Parse DB/DW/DD operands into bytes
    parseDataDirectiveArgs(mnemonic, rest, currentAddress, lineNum) {
        const bytes = [];
        const rawArgs = this.splitOperands(rest);
        for (const arg of rawArgs) {
            const trimArg = arg.trim();
            if ((trimArg.startsWith("'") && trimArg.endsWith("'")) || (trimArg.startsWith('"') && trimArg.endsWith('"'))) {
                const str = trimArg.slice(1, -1);
                for (let j = 0; j < str.length; j++) {
                    if (mnemonic === 'DB') bytes.push(str.charCodeAt(j));
                    else if (mnemonic === 'DW') bytes.push(...imm16ToBytes(str.charCodeAt(j)));
                    else bytes.push(...imm32ToBytes(str.charCodeAt(j)));
                }
            } else {
                const num = this.evaluateExpr(trimArg, currentAddress, this.sectionBase);
                if (isNaN(num)) throw new Error(`[Line ${lineNum+1}] Invalid ${mnemonic} operand: ${trimArg}`);
                if (mnemonic === 'DB') bytes.push(num & 0xFF);
                else if (mnemonic === 'DW') bytes.push(...imm16ToBytes(num));
                else bytes.push(...imm32ToBytes(num));
            }
        }
        return bytes;
    }

    splitOperands(operandsStr) {
        if (!operandsStr) return [];
        const result = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';
        let bracketDepth = 0;

        for (let i = 0; i < operandsStr.length; i++) {
            const char = operandsStr[i];
            if ((char === "'" || char === '"')) {
                if (!inQuotes) { inQuotes = true; quoteChar = char; }
                else if (quoteChar === char) { inQuotes = false; }
            }
            if (!inQuotes) {
                if (char === '[') bracketDepth++;
                if (char === ']') bracketDepth--;
            }
            if (char === ',' && !inQuotes && bracketDepth === 0) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        if (current.trim().length > 0) result.push(current.trim());
        return result;
    }

    parseOperand(opStr, currentAddress) {
        let cleanedStr = opStr.trim().toUpperCase().replace(/\s+/g, ' ');
        const originalStr = opStr.trim();
        
        // Multi-character literal: 'AB' -> packed value
        if ((cleanedStr.startsWith("'") && cleanedStr.endsWith("'")) || 
            (cleanedStr.startsWith('"') && cleanedStr.endsWith('"'))) {
            const inner = originalStr.slice(1, -1);
            if (inner.length === 1) {
                return { type: OpType.NUMBER, value: inner.charCodeAt(0) };
            }
            if (inner.length === 2) {
                // NASM packs as little-endian: 'AB' = 0x4241
                return { type: OpType.NUMBER, value: inner.charCodeAt(0) | (inner.charCodeAt(1) << 8) };
            }
            if (inner.length > 0) {
                // Pack up to 2 chars for word, or just first char for byte context
                let val = 0;
                for (let j = Math.min(inner.length, 2) - 1; j >= 0; j--) {
                    val = (val << 8) | inner.charCodeAt(j);
                }
                return { type: OpType.NUMBER, value: val };
            }
        }

        let isByte = false;
        let isWord = false;
        let prefixOuter = 0;

        const byteRegex = /^(?:BYTE\s+PTR|BYTE)\s+(.*)$/;
        const wordRegex = /^(?:WORD\s+PTR|WORD)\s+(.*)$/;

        if (byteRegex.test(cleanedStr)) { isByte = true; cleanedStr = cleanedStr.match(byteRegex)[1]; } 
        else if (wordRegex.test(cleanedStr)) { isWord = true; cleanedStr = cleanedStr.match(wordRegex)[1]; }

        // Strip SHORT/NEAR keyword for jump targets
        if (cleanedStr.startsWith('SHORT ')) { cleanedStr = cleanedStr.substring(6).trim(); }
        else if (cleanedStr.startsWith('NEAR ')) { cleanedStr = cleanedStr.substring(5).trim(); }

        if (/^(CS|DS|ES|SS):/.test(cleanedStr)) {
            const seg = cleanedStr.substring(0, 2);
            if (seg === 'ES') prefixOuter = 0x26;
            else if (seg === 'CS') prefixOuter = 0x2E;
            else if (seg === 'SS') prefixOuter = 0x36;
            else if (seg === 'DS') prefixOuter = 0x3E;
            cleanedStr = cleanedStr.substring(3).trim();
        }

        if (cleanedStr.startsWith('[') && cleanedStr.endsWith(']')) {
            const type = isByte ? OpType.MEM8 : isWord ? OpType.MEM16 : OpType.MEM_ANY;
            const memObj = this.parseMemory(cleanedStr, currentAddress);
            if (prefixOuter) memObj.prefixByte = prefixOuter;
            return { type, value: cleanedStr, mem: memObj };
        }

        if (REGISTERS[cleanedStr]) { 
            const reg = REGISTERS[cleanedStr];
            const type = reg.isSegment ? OpType.SEG_REG : (reg.size === 8 ? OpType.REG8 : OpType.REG16);
            return { type, value: cleanedStr, reg }; 
        }

        // Try to evaluate as expression (supports $, $$, arithmetic, hex/bin/oct)
        const num = this.evaluateExpr(cleanedStr, currentAddress, this.sectionBase);
        if (!isNaN(num)) return { type: OpType.NUMBER, value: num };

        // Resolve local label references
        let labelValue = cleanedStr;
        if (labelValue.startsWith('.')) {
            labelValue = this.currentGlobalLabel + labelValue;
        }
        return { type: OpType.LABEL, value: labelValue };
    }

    parseMemory(memStr, currentAddress) {
        let inner = memStr.slice(1, -1).trim().toUpperCase();
        let prefixByte = 0;

        if (inner.startsWith('ES:')) { prefixByte = 0x26; inner = inner.substring(3).trim(); }
        else if (inner.startsWith('CS:')) { prefixByte = 0x2E; inner = inner.substring(3).trim(); }
        else if (inner.startsWith('SS:')) { prefixByte = 0x36; inner = inner.substring(3).trim(); }
        else if (inner.startsWith('DS:')) { prefixByte = 0x3E; inner = inner.substring(3).trim(); }

        let disp = 0; let regs = [];
        const parts = inner.replace(/-/g, '+-').split('+').map(p => p.trim()).filter(p => p.length > 0);

        for (const p of parts) {
            if (['BX', 'BP', 'SI', 'DI'].includes(p)) { regs.push(p); } 
            else {
                const val = this.evaluateExpr(p, currentAddress, this.sectionBase);
                if (isNaN(val)) throw new Error(`Invalid memory operand component: ${p}`);
                disp += val;
            }
        }

        regs.sort();
        const regsKey = regs.join('+');
        let rm = -1; let mod = 0; let dispSize = 0;

        switch (regsKey) {
            case 'BX+SI': rm = 0; break; case 'BX+DI': rm = 1; break;
            case 'BP+SI': rm = 2; break; case 'BP+DI': rm = 3; break;
            case 'SI': rm = 4; break;    case 'DI': rm = 5; break;
            case 'BP': rm = 6; break;    case 'BX': rm = 7; break;
            case '': rm = 6; mod = 0b00; dispSize = 2; break; 
            default: throw new Error(`Invalid addressing mode: [${inner}]`);
        }

        if (regsKey !== '') {
            if (disp === 0 && regsKey !== 'BP') { mod = 0b00; dispSize = 0; } 
            else if (disp >= -128 && disp <= 127) { mod = 0b01; dispSize = 1; } 
            else { mod = 0b10; dispSize = 2; }
        }

        return { rm, mod, dispSize, dispValue: disp, prefixByte };
    }

    findMatchingRule(mnemonic, operands) {
        const rules = OPCODE_TABLE[mnemonic];
        if (!rules) return null;

        const matchedRules = [];

        for (const rule of rules) {
            if (rule.match.length !== operands.length) continue;
            // Skip near JMP rules unless we know this label needs near
            if (rule._isNear) {
                if (mnemonic === 'JMP' && this._nearJmpLabels && operands[0] &&
                    operands[0].type === OpType.LABEL && this._nearJmpLabels.has(operands[0].value)) {
                    // Use near rule for this label
                } else {
                    continue;
                }
            }

            let isMatch = true;
            for (let i = 0; i < rule.match.length; i++) {
                const expected = rule.match[i];
                const actual = operands[i].type;
                
                if (expected === actual) continue;
                if ((expected === OpType.MEM8 || expected === OpType.MEM16 || expected === OpType.MEM_ANY) && 
                    (actual === OpType.MEM_ANY || actual === OpType.MEM8 || actual === OpType.MEM16)) continue;
                
                isMatch = false;
                break;
            }

            if (isMatch) matchedRules.push(rule);
        }

        if (matchedRules.length === 0) return null;
        if (matchedRules.length > 1) {
            if (mnemonic === 'INT') {
                const numVal = operands[0].value;
                return matchedRules.find(r => r.size(operands) === (numVal === 3 ? 1 : 2)) || matchedRules[1];
            }

            // For JMP with near labels, prefer near rule
            if (mnemonic === 'JMP' && this._nearJmpLabels && operands[0] &&
                operands[0].type === OpType.LABEL && this._nearJmpLabels.has(operands[0].value)) {
                const nearRule = matchedRules.find(r => r._isNear);
                if (nearRule) return nearRule;
            }

            // Disambiguate MEM_ANY by register operand size
            const regOp = operands.find(op => op.type === OpType.REG8 || op.type === OpType.REG16);
            if (regOp) {
                const targetMemType = regOp.type === OpType.REG8 ? OpType.MEM8 : OpType.MEM16;
                const preferred = matchedRules.find(r => r.match.some((m, idx) => 
                    (operands[idx].type === OpType.MEM_ANY) && m === targetMemType));
                if (preferred) return preferred;
            }

            // Prefer specific MEM8/MEM16 rules over MEM_ANY fallbacks
            const specific = matchedRules.find(r => r.match.every(m => m !== OpType.MEM_ANY));
            if (specific) return specific;

            // Return first match as fallback
            return matchedRules[0];
        }

        return matchedRules[0];
    }

    parseNumber(str) {
        let cleanStr = str.trim().toLowerCase();
        let sign = 1;
        
        if (cleanStr.startsWith('-')) { sign = -1; cleanStr = cleanStr.substring(1).trim(); }
        else if (cleanStr.startsWith('+')) { cleanStr = cleanStr.substring(1).trim(); }

        let val;
        // Binary: 0b prefix or trailing 'b'
        if (cleanStr.startsWith('0b')) {
            val = parseInt(cleanStr.substring(2), 2);
        } else if (cleanStr.endsWith('b') && /^[01]+b$/.test(cleanStr)) {
            val = parseInt(cleanStr.slice(0, -1), 2);
        }
        // Octal: 0o prefix or trailing 'o'/'q'
        else if (cleanStr.startsWith('0o')) {
            val = parseInt(cleanStr.substring(2), 8);
        } else if ((cleanStr.endsWith('o') || cleanStr.endsWith('q')) && /^[0-7]+(o|q)$/.test(cleanStr)) {
            val = parseInt(cleanStr.slice(0, -1), 8);
        }
        // Hex: 0x prefix or trailing 'h'
        else if (cleanStr.endsWith('h')) {
            val = parseInt(cleanStr.slice(0, -1), 16);
        } else if (cleanStr.startsWith('0x')) {
            val = parseInt(cleanStr, 16);
        }
        // Decimal
        else {
            val = parseInt(cleanStr, 10);
        }
        
        return isNaN(val) ? NaN : sign * val;
    }

    // Evaluate a NASM-style expression with support for $, $$, labels, arithmetic
    evaluateExpr(expr, currentAddr, sectionBase) {
        if (!expr || !expr.trim()) return NaN;
        let safe = expr.trim().toUpperCase();

        // Replace $$ before $ to avoid partial replacement
        safe = safe.replace(/\$\$/g, '(' + sectionBase.toString() + ')');
        safe = safe.replace(/\$/g, '(' + currentAddr.toString() + ')');

        // Try to resolve known symbols/labels in expression
        safe = safe.replace(/\b([A-Z_][A-Z0-9_.]*)\b/g, (match) => {
            if (this.symbolTable.has(match)) {
                return this.symbolTable.get(match).toString();
            }
            return match;
        });

        // Parse number literals in the expression (hex with h suffix, binary with b suffix, octal with o/q)
        safe = safe.replace(/\b([0-9][0-9A-F]*)H\b/g, (_, num) => '0x' + num);
        safe = safe.replace(/\b0X([0-9A-F]+)\b/g, (_, num) => '0x' + num.toLowerCase());
        safe = safe.replace(/\b([01]+)B\b/g, (_, num) => parseInt(num, 2).toString());
        safe = safe.replace(/\b0B([01]+)\b/g, (_, num) => parseInt(num, 2).toString());
        safe = safe.replace(/\b([0-7]+)[OQ]\b/g, (_, num) => parseInt(num, 8).toString());
        safe = safe.replace(/\b0O([0-7]+)\b/g, (_, num) => parseInt(num, 8).toString());

        // Allow only safe characters for evaluation
        if (!/^[0-9A-FX\s+\-*/()]+$/i.test(safe)) {
            // Try as a plain number first
            return this.parseNumber(expr);
        }

        try {
            const result = Math.floor(Function('"use strict"; return (' + safe + ')')());
            return isNaN(result) ? NaN : result;
        } catch {
            return this.parseNumber(expr);
        }
    }

    // Resolve expression in pass 2 when all symbols are available
    resolveExprWithSymbols(expr, currentAddr, sectionBase, symbols) {
        if (!expr || !expr.trim()) return 0;
        let safe = expr.trim().toUpperCase();

        safe = safe.replace(/\$\$/g, '(' + sectionBase.toString() + ')');
        safe = safe.replace(/\$/g, '(' + currentAddr.toString() + ')');

        safe = safe.replace(/\b([A-Z_][A-Z0-9_.]*)\b/g, (match) => {
            if (symbols.has(match)) {
                return symbols.get(match).toString();
            }
            return match;
        });

        safe = safe.replace(/\b([0-9][0-9A-F]*)H\b/g, (_, num) => '0x' + num);
        safe = safe.replace(/\b0X([0-9A-F]+)\b/g, (_, num) => '0x' + num.toLowerCase());
        safe = safe.replace(/\b([01]+)B\b/g, (_, num) => parseInt(num, 2).toString());
        safe = safe.replace(/\b0B([01]+)\b/g, (_, num) => parseInt(num, 2).toString());
        safe = safe.replace(/\b([0-7]+)[OQ]\b/g, (_, num) => parseInt(num, 8).toString());
        safe = safe.replace(/\b0O([0-7]+)\b/g, (_, num) => parseInt(num, 8).toString());

        try {
            return Math.floor(Function('"use strict"; return (' + safe + ')')());
        } catch {
            throw new Error(`Cannot resolve expression: ${expr}`);
        }
    }

    // Split "count_expr sub_mnemonic [operands]" for TIMES directive
    splitTimesExpr(rest) {
        const tokens = rest.split(/\s+/);
        for (let i = 1; i < tokens.length; i++) {
            if (/^[A-Za-z]+$/.test(tokens[i])) {
                const countExpr = tokens.slice(0, i).join(' ');
                const subDirective = tokens.slice(i).join(' ');
                return [countExpr, subDirective];
            }
        }
        throw new Error(`Invalid TIMES syntax: ${rest}`);
    }
}

export { Assembler8086 };
