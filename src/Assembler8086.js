/**
 * 8086 Assembler - Ultimate Version (Vanilla JavaScript)
 * Supports Segment Override (ES:[DI]), DB/DW directives, and a Custom String Parser.
 */

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

function createAluRules(opcodeBase, extension) {
    return [
        { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => [opcodeBase + 0x02, encodeModRM(0b11, ops[0].reg.code, ops[1].reg.code)] },
        { match: [OpType.REG8, OpType.MEM8], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x02, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; } },
        { match: [OpType.REG16, OpType.REG16], size: () => 2, encode: (ops) => [opcodeBase + 0x03, encodeModRM(0b11, ops[0].reg.code, ops[1].reg.code)] },
        { match: [OpType.REG16, OpType.MEM16], size: (ops) => 2 + ops[1].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x03, encodeModRM(ops[1].mem.mod, ops[0].reg.code, ops[1].mem.rm)]; if (ops[1].mem.dispSize === 1) bytes.push(ops[1].mem.dispValue & 0xFF); else if (ops[1].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[1].mem.dispValue)); return bytes; } },
        { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x00, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.MEM16, OpType.REG16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [opcodeBase + 0x01, encodeModRM(ops[0].mem.mod, ops[1].reg.code, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } },
        { match: [OpType.REG8, OpType.NUMBER], size: (ops) => ops[0].reg.name === 'AL' ? 2 : 3, encode: (ops) => { if (ops[0].reg.name === 'AL') return [opcodeBase + 0x04, ops[1].value & 0xFF]; return [0x80, encodeModRM(0b11, extension, ops[0].reg.code), ops[1].value & 0xFF]; } },
        { match: [OpType.REG16, OpType.NUMBER], size: (ops) => ops[0].reg.name === 'AX' ? 3 : 4, encode: (ops) => { if (ops[0].reg.name === 'AX') return [opcodeBase + 0x05, ...imm16ToBytes(ops[1].value)]; return [0x81, encodeModRM(0b11, extension, ops[0].reg.code), ...imm16ToBytes(ops[1].value)]; } },
        { match: [OpType.MEM8, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize + 1, encode: (ops) => { const bytes = [0x80, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); bytes.push(ops[1].value & 0xFF); return bytes; } },
        { match: [OpType.MEM16, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize + 2, encode: (ops) => { const bytes = [0x81, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); bytes.push(...imm16ToBytes(ops[1].value)); return bytes; } }
    ];
}

function createMulDivRules(extension) { return [ { match: [OpType.REG8], size: () => 2, encode: (ops) => [0xF6, encodeModRM(0b11, extension, ops[0].reg.code)] }, { match: [OpType.REG16], size: () => 2, encode: (ops) => [0xF7, encodeModRM(0b11, extension, ops[0].reg.code)] }, { match: [OpType.MEM8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xF6, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } }, { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xF7, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; } } ]; }
function createNotNegRules(extension) { return createMulDivRules(extension); }
function createJmpRule(opcode) { return [{ match: [OpType.LABEL], size: () => 2, encode: (ops, offset, symbols) => { const label = ops[0].value; const targetOffset = symbols.get(label); if (targetOffset === undefined) throw new Error(`Label not found: ${label}`); const relOffset = targetOffset - (offset + 2); if (relOffset < -128 || relOffset > 127) throw new Error(`Jump distance exceeds 8-bit limit.`); return [opcode, relOffset < 0 ? 0x100 + relOffset : relOffset]; } }]; }
function createShiftRules(extension) { return [ { match: [OpType.REG8, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[1].value !== 1) throw new Error("Only supports shift immediate by 1."); return [0xD0, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM8, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].value !== 1) throw new Error("Only supports shift immediate by 1."); const bytes = [0xD0, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}, { match: [OpType.REG16, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[1].value !== 1) throw new Error("Only supports shift immediate by 1."); return [0xD1, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM16, OpType.NUMBER], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].value !== 1) throw new Error("Only supports shift immediate by 1."); const bytes = [0xD1, encodeModRM(0b11, extension, ops[0].reg.code)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}, { match: [OpType.REG8, OpType.REG8], size: () => 2, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); return [0xD2, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM8, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); const bytes = [0xD2, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}, { match: [OpType.REG16, OpType.REG8], size: () => 2, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); return [0xD3, encodeModRM(0b11, extension, ops[0].reg.code)]; }}, { match: [OpType.MEM16, OpType.REG8], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { if (ops[1].reg.name !== 'CL') throw new Error("Must use CL register for multi-bit shift."); const bytes = [0xD3, encodeModRM(ops[0].mem.mod, extension, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }} ]; }


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
        { match: [OpType.REG16], size: () => 2, encode: (ops) => [0xFF, encodeModRM(0b11, 2, ops[0].reg.code)] },
        { match: [OpType.MEM16], size: (ops) => 2 + ops[0].mem.dispSize, encode: (ops) => { const bytes = [0xFF, encodeModRM(ops[0].mem.mod, 2, ops[0].mem.rm)]; if (ops[0].mem.dispSize === 1) bytes.push(ops[0].mem.dispValue & 0xFF); else if (ops[0].mem.dispSize === 2) bytes.push(...imm16ToBytes(ops[0].mem.dispValue)); return bytes; }}
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
        { match: [OpType.REG8, OpType.NUMBER], size: () => 2, encode: (ops) => { if (ops[0].reg.name === 'AL') return [0xA8, ops[1].value & 0xFF]; return [0xF6, encodeModRM(0b11, 0, ops[0].reg.code), ops[1].value & 0xFF]; }},
        { match: [OpType.REG16, OpType.NUMBER], size: () => 3, encode: (ops) => { if (ops[0].reg.name === 'AX') return [0xA9, ...imm16ToBytes(ops[1].value)]; return [0xF7, encodeModRM(0b11, 0, ops[0].reg.code), ...imm16ToBytes(ops[1].value)]; }},
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

    'XCHG': [
        { match: [OpType.REG16, OpType.REG16], size: () => 2, encode: (ops) => { if (ops[0].reg.name === 'AX') return [0x90 + ops[1].reg.code]; if (ops[1].reg.name === 'AX') return [0x90 + ops[0].reg.code]; return [0x87, encodeModRM(0b11, ops[1].reg.code, ops[0].reg.code)]; }},
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
    'CLD': [{ match: [], size: () => 1, encode: () => [0xFC] }], 'STD': [{ match: [], size: () => 1, encode: () => [0xFD] }],

    'JMP':  createJmpRule(0xEB),
    'JE':   createJmpRule(0x74), 'JZ':   createJmpRule(0x74), 'JNE':  createJmpRule(0x75), 'JNZ':  createJmpRule(0x75), 
    'JA':   createJmpRule(0x77), 'JNBE': createJmpRule(0x77), 'JAE':  createJmpRule(0x73), 'JNB':  createJmpRule(0x73), 'JNC':  createJmpRule(0x73),
    'JB':   createJmpRule(0x72), 'JNAE': createJmpRule(0x72), 'JC':   createJmpRule(0x72), 'JBE':  createJmpRule(0x76), 'JNA':  createJmpRule(0x76),
    'JG':   createJmpRule(0x7F), 'JNLE': createJmpRule(0x7F), 'JGE':  createJmpRule(0x7D), 'JNL':  createJmpRule(0x7D),
    'JL':   createJmpRule(0x7C), 'JNGE': createJmpRule(0x7C), 'JLE':  createJmpRule(0x7E), 'JNG':  createJmpRule(0x7E),
    'JO':   createJmpRule(0x70), 'JNO':  createJmpRule(0x71), 'JS':   createJmpRule(0x78), 'JNS':  createJmpRule(0x79),
    'JP':   createJmpRule(0x7A), 'JPE':  createJmpRule(0x7A), 'JNP':  createJmpRule(0x7B), 'JPO':  createJmpRule(0x7B),

    'LOOP':   createJmpRule(0xE2), 'LOOPE':  createJmpRule(0xE1), 'LOOPZ':  createJmpRule(0xE1),
    'LOOPNE': createJmpRule(0xE0), 'LOOPNZ': createJmpRule(0xE0), 'JCXZ':   createJmpRule(0xE3)
};

class Assembler8086 {
    constructor() {
        this.symbolTable = new Map();
        this.lines = [];
    }

    assemble(sourceCode) {
        this.symbolTable.clear();
        this.lines = [];
        this.pass1(sourceCode);
        return this.pass2();
    }

    pass1(sourceCode) {
        const rawLines = sourceCode.split('\n');
        let currentAddress = 0;
        let sectionBase = 0;
        const lineRegex = /^\s*(?:([a-zA-Z_][a-zA-Z0-9_]*):)?\s*(?:(\.?[a-zA-Z]+)(?:\s+([a-zA-Z]+))?\s*([^;]*))?(?:;.*)?$/;

        for (let i = 0; i < rawLines.length; i++) {
            let cleaned = rawLines[i].trim();
            if (!cleaned || cleaned.startsWith(';')) continue;

            if (cleaned.startsWith('[') && cleaned.endsWith(']') && cleaned.toUpperCase().includes('ORG')) {
                cleaned = cleaned.substring(1, cleaned.length - 1).trim();
            }
            
            let inStr = false;
            let commentIdx = -1;
            let quoteChar = '';
            for(let j = 0; j < cleaned.length; j++) {
                const char = cleaned[j];
                if(char === "'" || char === '"') {
                    if (!inStr) { inStr = true; quoteChar = char; }
                    else if (char === quoteChar) { inStr = false; }
                }
                if(char === ';' && !inStr) { commentIdx = j; break; }
            }
            if (commentIdx !== -1) cleaned = cleaned.substring(0, commentIdx).trim();
            if (!cleaned) continue;

            let label = null;
            const colonIdx = cleaned.indexOf(':');
            if (colonIdx !== -1 && !cleaned.substring(0, colonIdx).includes("'") && !cleaned.substring(0, colonIdx).includes('"')) {
                const beforeColon = cleaned.substring(0, colonIdx).trim();
                // Only treat as label if it's a single valid identifier, not a segment register
                if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(beforeColon) && !['ES','CS','SS','DS'].includes(beforeColon.toUpperCase())) {
                    label = beforeColon;
                    cleaned = cleaned.substring(colonIdx + 1).trim();
                }
            }
            if (!label) {
                const firstSpace = cleaned.indexOf(' ');
                const firstToken = firstSpace !== -1 ? cleaned.substring(0, firstSpace) : cleaned;
                const upperToken = firstToken.toUpperCase();
                if (!OPCODE_TABLE[upperToken] && !['ORG', 'DB', 'DW', 'TIMES'].includes(upperToken)) {
                    label = firstToken;
                    cleaned = cleaned.substring(firstToken.length).trim();
                }
            }

            if (label) this.symbolTable.set(label.toUpperCase(), currentAddress);
            if (!cleaned) continue;

            const firstSpace = cleaned.indexOf(' ');
            const mnemonic1 = firstSpace !== -1 ? cleaned.substring(0, firstSpace).toUpperCase() : cleaned.toUpperCase();
            let rest = firstSpace !== -1 ? cleaned.substring(firstSpace + 1).trim() : '';

            if (mnemonic1 === 'ORG' || mnemonic1 === '.ORG') {
                const newOrg = this.parseNumber(rest);
                if (isNaN(newOrg)) throw new Error(`[Pass 1] Invalid ORG operand: ${rest}`);
                currentAddress = newOrg;
                sectionBase = newOrg;
                continue;
            }

            if (mnemonic1 === 'TIMES') {
                const [countExpr, subDirective] = this.splitTimesExpr(rest);
                const count = this.evaluateExpr(countExpr, currentAddress, sectionBase);
                if (isNaN(count) || count < 0) throw new Error(`[Pass 1] Invalid TIMES count expression: ${countExpr}`);

                const subFirstSpace = subDirective.indexOf(' ');
                const subMnemonic = (subFirstSpace !== -1 ? subDirective.substring(0, subFirstSpace) : subDirective).toUpperCase();
                const subRest = subFirstSpace !== -1 ? subDirective.substring(subFirstSpace + 1).trim() : '';

                if (subMnemonic === 'DB' || subMnemonic === 'DW') {
                    const unitBytes = [];
                    const rawArgs = this.splitOperands(subRest);
                    for (const arg of rawArgs) {
                        if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
                            const str = arg.slice(1, -1);
                            for (let j = 0; j < str.length; j++) {
                                if (subMnemonic === 'DB') unitBytes.push(str.charCodeAt(j));
                                else unitBytes.push(...imm16ToBytes(str.charCodeAt(j)));
                            }
                        } else {
                            const num = this.parseNumber(arg);
                            if (isNaN(num)) throw new Error(`[Pass 1] Invalid TIMES ${subMnemonic} operand: ${arg}`);
                            if (subMnemonic === 'DB') unitBytes.push(num & 0xFF);
                            else unitBytes.push(...imm16ToBytes(num));
                        }
                    }
                    const repeatedBytes = [];
                    for (let t = 0; t < count; t++) repeatedBytes.push(...unitBytes);
                    const parsedLine = { original: rawLines[i], label, mnemonic: 'TIMES', operands: [], offset: currentAddress };
                    parsedLine.rule = { match: [], size: () => repeatedBytes.length, encode: () => repeatedBytes };
                    currentAddress += repeatedBytes.length;
                    this.lines.push(parsedLine);
                    continue;
                }
                throw new Error(`[Pass 1] TIMES only supports DB/DW sub-directives: ${subMnemonic}`);
            }

            if (mnemonic1 === 'DB' || mnemonic1 === 'DW') {
                const bytes = [];
                const rawArgs = this.splitOperands(rest);
                for (let arg of rawArgs) {
                    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
                        const str = arg.slice(1, -1);
                        for (let j = 0; j < str.length; j++) {
                            if (mnemonic1 === 'DB') bytes.push(str.charCodeAt(j));
                            else bytes.push(...imm16ToBytes(str.charCodeAt(j)));
                        }
                    } else {
                        const num = this.parseNumber(arg);
                        if (isNaN(num)) throw new Error(`[Pass 1] Invalid DB/DW operand: ${arg}`);
                        if (mnemonic1 === 'DB') bytes.push(num & 0xFF);
                        else bytes.push(...imm16ToBytes(num));
                    }
                }
                const parsedLine = { original: rawLines[i], label, mnemonic: mnemonic1, operands: [], offset: currentAddress };
                parsedLine.rule = { match: [], size: () => bytes.length, encode: () => bytes };
                currentAddress += bytes.length;
                this.lines.push(parsedLine);
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
                parsedLine.operands = rawOperands.map(op => this.parseOperand(op));

                const rule = this.findMatchingRule(item.m, parsedLine.operands);
                if (!rule) throw new Error(`[Pass 1] Unsupported opcode or syntax error: ${item.m} ${item.ops}`);
                
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
                    throw new Error(`Size mismatch: Instruction ${line.mnemonic} generated incorrect length.`);
                }
                output.push(...bytes);
            } catch (err) {
                throw new Error(`[Pass 2] Error at line "${line.original.trim()}": ${err.message}`);
            }
        }
        return new Uint8Array(output);
    }

    splitOperands(operandsStr) {
        if (!operandsStr) return [];
        const result = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < operandsStr.length; i++) {
            const char = operandsStr[i];
            if ((char === "'" || char === '"')) {
                if (!inQuotes) { inQuotes = true; quoteChar = char; }
                else if (quoteChar === char) { inQuotes = false; }
            }
            if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        if (current.trim().length > 0) result.push(current.trim());
        return result;
    }

    parseOperand(opStr) {
        let cleanedStr = opStr.trim().toUpperCase().replace(/\s+/g, ' ');
        
        if (cleanedStr.length === 3 && cleanedStr.startsWith("'") && cleanedStr.endsWith("'")) {
            return { type: OpType.NUMBER, value: opStr.trim().charCodeAt(1) };
        }
        if (cleanedStr.length === 3 && cleanedStr.startsWith('"') && cleanedStr.endsWith('"')) {
            return { type: OpType.NUMBER, value: opStr.trim().charCodeAt(1) };
        }

        let isByte = false;
        let isWord = false;
        let prefixOuter = 0;

        const byteRegex = /^(?:BYTE\s+PTR|BYTE)\s+(.*)$/;
        const wordRegex = /^(?:WORD\s+PTR|WORD)\s+(.*)$/;

        if (byteRegex.test(cleanedStr)) { isByte = true; cleanedStr = cleanedStr.match(byteRegex)[1]; } 
        else if (wordRegex.test(cleanedStr)) { isWord = true; cleanedStr = cleanedStr.match(wordRegex)[1]; }

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
            const memObj = this.parseMemory(cleanedStr);
            if (prefixOuter) memObj.prefixByte = prefixOuter;
            return { type, value: cleanedStr, mem: memObj };
        }

        if (REGISTERS[cleanedStr]) { 
            const reg = REGISTERS[cleanedStr];
            const type = reg.isSegment ? OpType.SEG_REG : (reg.size === 8 ? OpType.REG8 : OpType.REG16);
            return { type, value: cleanedStr, reg }; 
        }

        const num = this.parseNumber(cleanedStr);
        if (!isNaN(num)) return { type: OpType.NUMBER, value: num };

        return { type: OpType.LABEL, value: cleanedStr };
    }

    parseMemory(memStr) {
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
            else { disp += this.parseNumber(p); }
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

            let isMatch = true;
            for (let i = 0; i < rule.match.length; i++) {
                const expected = rule.match[i];
                const actual = operands[i].type;
                
                if (expected === actual) continue;
                if ((expected === OpType.MEM8 || expected === OpType.MEM16) && actual === OpType.MEM_ANY) continue;
                
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
            if (mnemonic === 'XCHG') { return matchedRules.find(r => r.size(operands) === 1) || matchedRules[0]; }
            if (mnemonic === 'RETF') { return matchedRules.find(r => r.size(operands) === 1) || matchedRules[0]; }

            // Disambiguate MEM_ANY by register operand size
            const regOp = operands.find(op => op.type === OpType.REG8 || op.type === OpType.REG16);
            if (regOp) {
                const targetMemType = regOp.type === OpType.REG8 ? OpType.MEM8 : OpType.MEM16;
                const preferred = matchedRules.find(r => r.match.some((m, i) => operands[i].type === OpType.MEM_ANY && m === targetMemType));
                if (preferred) return preferred;
            }

            // Prefer specific MEM8/MEM16 rules over MEM_ANY fallbacks
            const specific = matchedRules.find(r => r.match.every(m => m !== OpType.MEM_ANY));
            if (specific) return specific;

            throw new Error(`Ambiguous operand size at instruction ${mnemonic}.`);
        }

        return matchedRules[0];
    }

    parseNumber(str) {
        let cleanStr = str.trim().toLowerCase();
        let sign = 1;
        
        if (cleanStr.startsWith('-')) { sign = -1; cleanStr = cleanStr.substring(1).trim(); }
        else if (cleanStr.startsWith('+')) { cleanStr = cleanStr.substring(1).trim(); }

        let val;
        if (cleanStr.endsWith('h')) val = parseInt(cleanStr.slice(0, -1), 16);
        else if (cleanStr.startsWith('0x')) val = parseInt(cleanStr, 16);
        else val = parseInt(cleanStr, 10);
        
        return isNaN(val) ? NaN : sign * val;
    }

    // Evaluate a NASM-style expression: supports $, $$, +, -, *, /, parentheses, hex/decimal numbers
    evaluateExpr(expr, currentAddr, sectionBase) {
        // Replace $$ before $ to avoid partial replacement
        let safe = expr.trim()
            .replace(/\$\$/g, sectionBase.toString())
            .replace(/\$/g, currentAddr.toString());
        // Allow only safe arithmetic characters
        if (!/^[\d\s\+\-\*\/\(\)]+$/.test(safe)) return NaN;
        try {
            // eslint-disable-next-line no-new-func
            return Math.floor(new Function('return (' + safe + ')')());
        } catch {
            return NaN;
        }
    }

    // Split "count_expr sub_mnemonic [operands]" for TIMES directive
    // e.g. "510-($-$$) db 0" -> ["510-($-$$)", "db 0"]
    splitTimesExpr(rest) {
        const tokens = rest.split(/\s+/);
        // Scan left-to-right; the sub-directive starts at the first token that is purely alphabetic
        // (a mnemonic), which must also not be the very first token
        for (let i = 1; i < tokens.length; i++) {
            if (/^[A-Za-z]+$/.test(tokens[i])) {
                const countExpr = tokens.slice(0, i).join(' ');
                const subDirective = tokens.slice(i).join(' ');
                return [countExpr, subDirective];
            }
        }
        throw new Error(`[Pass 1] Invalid TIMES syntax: ${rest}`);
    }
}

export { Assembler8086 };
