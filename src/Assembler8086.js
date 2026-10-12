/**
 * 8086 / 80186 assembler — NASM-compatible subset (vanilla JavaScript).
 *
 * Pipeline:
 *   preprocess  %define substitution (other % directives are rejected, never silently dropped)
 *   pass 1      parse every line, lay out addresses, build the symbol table. Operands keep their
 *               expression ASTs; a symbol that is not defined yet makes the operand `unresolved`,
 *               which always selects the wide (16-bit) encoding so sizes never change later.
 *   relaxation  short JMPs whose target is out of range are promoted to near and pass 1 re-runs,
 *               until no jump changes (monotone, so it terminates).
 *   pass 2      resolve all expressions against the final symbol table and encode.
 *
 * Features: labels (local `.x`), EQU (forward references allowed), `$` / `$$`, full NASM integer
 * expressions, DB/DW/DD, TIMES, RESB/RESW/RESD, ALIGN, ORG, `CPU 8086|186`, REP/LOCK prefixes,
 * segment overrides, BYTE/WORD/DWORD/FAR/SHORT/NEAR qualifiers, far JMP/CALL.
 *
 * After `assemble()`: `origin` = load address, `cpu` = CPU level the program needs ('8086' | '186'),
 * `warnings` = non-fatal diagnostics, `symbolTable` = label/EQU values.
 */
import { parseExpression, evaluate } from './asm/expression.js';
import {
    REGISTERS, CPU_LEVEL, UNSUPPORTED_MNEMONICS,
    hasInstruction, findRule, ruleSize, isRelaxableJump, le16, le32,
} from './asm/instructions.js';

const NOP_OPCODE = 0x90;
const LABEL_RE = /^\.?[A-Za-z_?@][A-Za-z0-9_.?@$#~]*$/;
const SEGMENT_NAMES = ['ES', 'CS', 'SS', 'DS'];
const PREFIX_MNEMONICS = new Set(['REP', 'REPE', 'REPZ', 'REPNE', 'REPNZ', 'LOCK']);
const DIRECTIVES = new Set(['ORG', '.ORG', 'DB', 'DW', 'DD', 'TIMES', 'EQU', 'RESB', 'RESW', 'RESD', 'ALIGN',
    'SECTION', 'SEGMENT', 'BITS', 'GLOBAL', 'EXTERN', 'CPU']);
const MEM_RM = { 'BX+SI': 0, 'BX+DI': 1, 'BP+SI': 2, 'BP+DI': 3, 'SI': 4, 'DI': 5, 'BP': 6, 'BX': 7 };
const SEG_PREFIX = { ES: 0x26, CS: 0x2E, SS: 0x36, DS: 0x3E };

const normalizeCpu = (text) => {
    const t = String(text).trim().toUpperCase();
    if (['8086', '8088', 'I8086', '86'].includes(t)) return '8086';
    if (['186', '80186', '188', '80188'].includes(t)) return '186';
    throw new Error(`Unsupported CPU '${text}': this assembler targets the 8086 and 80186 ('cpu 8086' / 'cpu 186')`);
};

/** Index of `ch` at nesting depth 0 outside quotes, or -1. */
const indexOfTopLevel = (text, ch) => {
    let depth = 0; let quote = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === '[' || c === '(') depth++;
        else if (c === ']' || c === ')') depth--;
        else if (c === ch && depth === 0) return i;
    }
    return -1;
};

const splitTopLevel = (text, ch) => {
    const parts = [];
    let rest = text;
    for (;;) {
        const idx = indexOfTopLevel(rest, ch);
        if (idx === -1) { parts.push(rest.trim()); break; }
        parts.push(rest.slice(0, idx).trim());
        rest = rest.slice(idx + 1);
    }
    return parts.filter((p, i, a) => !(p === '' && a.length === 1));
};

const stripComment = (line) => {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === "'" || c === '"') quote = c;
        else if (c === ';') return line.slice(0, i);
    }
    return line;
};

/** `'text'` / `"text"` with no other tokens -> its characters, otherwise null. */
const pureString = (arg) => {
    const m = /^'([^']*)'$/.exec(arg) || /^"([^"]*)"$/.exec(arg);
    return m ? [...m[1]].map((ch) => ch.charCodeAt(0) & 0xFF) : null;
};

class Assembler8086 {
    constructor() {
        this.symbolTable = new Map();
        this.lines = [];
        this.defines = new Map();
        this.warnings = [];
        this.currentGlobalLabel = '';
        this.sectionBase = 0;
        this.origin = 0;
        this.cpu = '8086';
        this.qualify = (name) => (name.startsWith('.') ? this.currentGlobalLabel + name : name);
    }

    /**
     * Assemble source text to machine code.
     *
     * @param {string} sourceCode
     * @param {{origin?: number, cpu?: string}} [options]
     *   origin - load address used when the source has no ORG
     *   cpu    - '8086' (default) or '186'; a `CPU` directive in the source can raise it
     * @returns {Uint8Array}
     */
    assemble(sourceCode, options = {}) {
        this.defaultOrigin = options.origin ?? 0;
        this.startCpu = normalizeCpu(options.cpu ?? '8086');
        this.warnings = [];
        this.defines = new Map();
        const source = this.preprocess(sourceCode);

        const longJumps = new Set();
        const maxPasses = source.split('\n').length + 2;
        for (let pass = 0; ; pass++) {
            this.pass1(source, longJumps);
            if (!this.relax(longJumps)) break;
            if (pass > maxPasses) throw new Error('Assembly failed: jump sizes did not converge');
        }
        return this.pass2();
    }

    // ------------------------------------------------------------------ preprocessor
    preprocess(sourceCode) {
        const out = [];
        sourceCode.split('\n').forEach((rawLine, i) => {
            const line = rawLine.replace(/\r$/, '');
            const trimmed = line.trim();
            if (trimmed.startsWith('%')) {
                const word = trimmed.split(/\s+/)[0].toLowerCase();
                if (word !== '%define') {
                    throw new Error(`[Line ${i + 1}] Unsupported preprocessor directive '${word}' (only %define is available)`);
                }
                const rest = stripComment(trimmed.substring(7)).trim();
                const sp = rest.search(/\s/);
                const name = sp === -1 ? rest : rest.substring(0, sp);
                this.defines.set(name, sp === -1 ? '' : rest.substring(sp + 1).trim());
                out.push('');
                return;
            }
            let text = line;
            for (const [name, value] of this.defines) {
                if (text.includes(name)) {
                    text = text.replace(new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), value);
                }
            }
            out.push(text);
        });
        return out.join('\n');
    }

    // ------------------------------------------------------------------ expressions
    makeExpr(text, here) {
        return { ast: parseExpression(text, this.qualify), here, base: this.sectionBase };
    }

    /** Evaluate a stored expression against the symbol table as it is *now*. */
    evalExpr(expr) {
        return evaluate(expr.ast, { lookup: (n) => this.symbolTable.get(n), here: expr.here, base: expr.base });
    }

    /** Evaluate and require every symbol to be known (pass 2). */
    requireExpr(expr, what) {
        const r = this.evalExpr(expr);
        if (r.unresolved) throw new Error(`undefined symbol ${r.missing.map((m) => `'${m}'`).join(', ')} in ${what}`);
        return r.value;
    }

    // ------------------------------------------------------------------ operands
    splitOperands(text) {
        return text ? splitTopLevel(text, ',') : [];
    }

    parseOperand(text, here) {
        let s = text.trim();
        if (!s) throw new Error('Missing operand');
        let size = null;
        let hint = null;
        for (;;) {
            const m = /^(BYTE|WORD|DWORD|SHORT|NEAR|FAR|PTR)\b\s*/i.exec(s);
            if (!m) break;
            const kw = m[1].toUpperCase();
            if (kw === 'BYTE') size = 8;
            else if (kw === 'WORD') size = 16;
            else if (kw === 'DWORD') size = 32;
            else if (kw === 'FAR') { size = 32; hint = 'far'; }
            else if (kw === 'SHORT' || kw === 'NEAR') hint = kw.toLowerCase();
            s = s.slice(m[0].length);
        }

        let prefix = 0;
        const segMatch = /^(CS|DS|ES|SS)\s*:\s*(\[.*\])$/i.exec(s);
        if (segMatch) { prefix = SEG_PREFIX[segMatch[1].toUpperCase()]; s = segMatch[2]; }

        if (s.startsWith('[') && s.endsWith(']')) {
            return { type: 'mem', mem: this.parseMemory(s.slice(1, -1), size, prefix, here), hint };
        }

        const reg = REGISTERS[s.toUpperCase()];
        if (reg) return { type: reg.isSegment ? 'sreg' : (reg.size === 8 ? 'reg8' : 'reg16'), reg };

        const colon = indexOfTopLevel(s, ':');
        if (colon !== -1) {
            const seg = this.makeExpr(s.slice(0, colon), here);
            const off = this.makeExpr(s.slice(colon + 1), here);
            return { type: 'farptr', segExpr: seg, offExpr: off, seg: { value: 0 }, off: { value: 0 }, hint };
        }

        const expr = this.makeExpr(s, here);
        const r = this.evalExpr(expr);
        return { type: 'imm', expr, value: r.value, unresolved: r.unresolved, hint };
    }

    parseMemory(inner, size, prefix, here) {
        let body = inner.trim();
        const seg = /^(CS|DS|ES|SS)\s*:\s*/i.exec(body);
        if (seg) { prefix = SEG_PREFIX[seg[1].toUpperCase()]; body = body.slice(seg[0].length); }

        // Split into signed top-level terms; base/index registers are pulled out, the rest is the displacement.
        const terms = [];
        let depth = 0; let sign = 1; let current = '';
        const push = () => { if (current.trim()) terms.push({ sign, text: current.trim() }); current = ''; };
        for (const c of body) {
            if (c === '(') depth++;
            if (c === ')') depth--;
            if ((c === '+' || c === '-') && depth === 0 && current.trim() !== '') {
                push(); sign = c === '-' ? -1 : 1;
            } else if ((c === '+' || c === '-') && depth === 0) {
                sign = c === '-' ? -sign : sign;
            } else {
                current += c;
            }
        }
        push();

        const regs = [];
        const dispTerms = [];
        for (const t of terms) {
            const upper = t.text.toUpperCase();
            if (['BX', 'BP', 'SI', 'DI'].includes(upper)) {
                if (t.sign < 0) throw new Error(`Invalid addressing mode: [${inner}]`);
                regs.push(upper);
            } else {
                dispTerms.push(`${t.sign < 0 ? '-' : '+'}(${t.text})`);
            }
        }
        regs.sort();
        const key = regs.join('+');
        if (key !== '' && !(key in MEM_RM)) throw new Error(`Invalid addressing mode: [${inner}]`);

        let expr = null; let dispValue = 0; let unresolved = false;
        if (dispTerms.length > 0) {
            expr = this.makeExpr(dispTerms.join(''), here);
            const r = this.evalExpr(expr);
            dispValue = r.value; unresolved = r.unresolved;
        }

        let rm; let mod; let dispSize;
        if (key === '') { rm = 6; mod = 0; dispSize = 2; }
        else {
            rm = MEM_RM[key];
            if (!unresolved && dispValue === 0 && key !== 'BP') { mod = 0; dispSize = 0; }
            else if (!unresolved && dispValue >= -128 && dispValue <= 127) { mod = 1; dispSize = 1; }
            else { mod = 2; dispSize = 2; }
        }
        return { rm, mod, dispSize, dispValue, expr, prefix, direct: key === '', size };
    }

    /** Fill in the final numeric values of an operand's expressions (pass 2). */
    resolveOperand(op, text) {
        if (op.type === 'imm') op.value = this.requireExpr(op.expr, text);
        else if (op.type === 'mem' && op.mem.expr) op.mem.dispValue = this.requireExpr(op.mem.expr, text);
        else if (op.type === 'farptr') {
            op.seg = { value: this.requireExpr(op.segExpr, text) };
            op.off = { value: this.requireExpr(op.offExpr, text) };
        }
    }

    // ------------------------------------------------------------------ pass 1
    defineSymbol(name, value, lineNo) {
        if (this.symbolTable.has(name)) throw new Error(`[Line ${lineNo}] Symbol '${name}' is already defined`);
        this.symbolTable.set(name, value);
    }

    pass1(source, longJumps) {
        const rawLines = source.split('\n');
        this.symbolTable.clear();
        this.lines = [];
        this.currentGlobalLabel = '';
        this.sectionBase = this.defaultOrigin;
        this.origin = this.defaultOrigin;
        this.cpu = this.startCpu;
        this.curCpu = this.startCpu;
        this.pendingEqu = [];
        let addr = this.defaultOrigin;

        const emitLine = (line) => { this.lines.push(line); addr += line.size; };

        for (let i = 0; i < rawLines.length; i++) {
            const lineNo = i + 1;
            let cleaned = stripComment(rawLines[i]).trim();
            if (!cleaned) continue;
            try {
                // Bracketed directives: [ORG ...] [BITS 16]
                if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
                    const inner = cleaned.slice(1, -1).trim();
                    if (/^ORG\b/i.test(inner)) cleaned = inner;
                    else if (/^BITS\b/i.test(inner)) { this.checkBits(inner.slice(4)); continue; }
                    else continue;
                }

                // Label (with or without colon)
                let label = null;
                const colonIdx = cleaned.indexOf(':');
                if (colonIdx !== -1) {
                    const before = cleaned.slice(0, colonIdx).trim();
                    if (LABEL_RE.test(before) && !SEGMENT_NAMES.includes(before.toUpperCase())) {
                        label = before;
                        cleaned = cleaned.slice(colonIdx + 1).trim();
                    }
                }
                if (!label && cleaned) {
                    const firstToken = cleaned.split(/\s+/)[0];
                    const upper = firstToken.toUpperCase();
                    const known = hasInstruction(upper) || DIRECTIVES.has(upper) || PREFIX_MNEMONICS.has(upper)
                        || UNSUPPORTED_MNEMONICS.has(upper);
                    if (!known && LABEL_RE.test(firstToken)) {
                        label = firstToken;
                        cleaned = cleaned.slice(firstToken.length).trim(); // keep the rest verbatim (string spacing)
                    }
                }

                let mnemonic = ''; let rest = '';
                if (cleaned) {
                    const sp = cleaned.search(/\s/);
                    mnemonic = (sp === -1 ? cleaned : cleaned.slice(0, sp)).toUpperCase();
                    rest = sp === -1 ? '' : cleaned.slice(sp + 1).trim();
                }

                // Define the label (EQU gives the symbol a value instead of an address)
                let labelKey = null;
                if (label) {
                    labelKey = label.startsWith('.') ? this.currentGlobalLabel + label.toUpperCase() : label.toUpperCase();
                    if (!label.startsWith('.')) this.currentGlobalLabel = label.toUpperCase();
                    if (mnemonic !== 'EQU') this.defineSymbol(labelKey, addr, lineNo);
                }
                if (!mnemonic) continue;

                if (mnemonic === 'EQU') {
                    if (!labelKey) throw new Error('EQU requires a label');
                    const expr = this.makeExpr(rest, addr);
                    const r = this.evalExpr(expr);
                    if (r.unresolved) this.pendingEqu.push({ key: labelKey, expr, lineNo });
                    else this.defineSymbol(labelKey, r.value, lineNo);
                    continue;
                }

                if (mnemonic === 'ORG' || mnemonic === '.ORG') {
                    const v = this.requireNow(rest, addr, 'ORG');
                    addr = v;
                    this.sectionBase = v;
                    if (this.lines.length === 0) this.origin = v;
                    continue;
                }
                if (mnemonic === 'CPU') {
                    this.curCpu = normalizeCpu(rest);
                    if (CPU_LEVEL[this.curCpu] > CPU_LEVEL[this.cpu]) this.cpu = this.curCpu;
                    continue;
                }
                if (mnemonic === 'BITS') { this.checkBits(rest); continue; }
                if (['SECTION', 'SEGMENT', 'GLOBAL', 'EXTERN'].includes(mnemonic)) continue;

                if (mnemonic === 'ALIGN') {
                    const [alignText, fillText] = splitTopLevel(rest, ',');
                    const n = this.requireNow(alignText, addr, 'ALIGN');
                    if (n <= 0) throw new Error(`Invalid ALIGN value: ${rest}`);
                    const fill = fillText ? this.requireNow(fillText.replace(/^db\s+/i, ''), addr, 'ALIGN fill') & 0xFF : NOP_OPCODE;
                    const pad = (n - (addr % n)) % n;
                    if (pad > 0) emitLine({ src: lineNo, offset: addr, size: pad, emit: () => new Array(pad).fill(fill) });
                    continue;
                }

                if (mnemonic === 'RESB' || mnemonic === 'RESW' || mnemonic === 'RESD') {
                    const count = this.requireNow(rest, addr, mnemonic);
                    if (count < 0) throw new Error(`Invalid ${mnemonic} count: ${rest}`);
                    const total = count * (mnemonic === 'RESB' ? 1 : mnemonic === 'RESW' ? 2 : 4);
                    emitLine({ src: lineNo, offset: addr, size: total, emit: () => new Array(total).fill(0) });
                    continue;
                }

                if (mnemonic === 'TIMES') {
                    const { countText, sub } = this.splitTimes(rest);
                    const count = this.requireNow(countText, addr, 'TIMES count');
                    if (count < 0) throw new Error(`Invalid TIMES count: ${countText}`);
                    for (let t = 0; t < count; t++) this.parseStatement(sub, addr, lineNo, longJumps, emitLine, () => addr);
                    continue;
                }

                this.parseStatement(`${mnemonic} ${rest}`.trim(), addr, lineNo, longJumps, emitLine, () => addr);
            } catch (err) {
                if (/^\[Line /.test(err.message)) throw err;
                throw new Error(`[Line ${lineNo}] ${err.message}`);
            }
        }
        this.resolvePendingEqu();
    }

    checkBits(text) {
        if (text.trim() !== '16') throw new Error(`Only BITS 16 is supported (got '${text.trim()}')`);
    }

    /** Evaluate an expression that must be fully known during pass 1 (ORG, TIMES count, ...). */
    requireNow(text, here, what) {
        const r = this.evalExpr(this.makeExpr(text, here));
        if (r.unresolved) throw new Error(`${what} needs a value known when it is read; undefined: ${r.missing.join(', ')}`);
        return r.value;
    }

    resolvePendingEqu() {
        let progress = true;
        while (this.pendingEqu.length > 0 && progress) {
            progress = false;
            this.pendingEqu = this.pendingEqu.filter((p) => {
                const r = this.evalExpr(p.expr);
                if (r.unresolved) return true;
                this.defineSymbol(p.key, r.value, p.lineNo);
                progress = true;
                return false;
            });
        }
        if (this.pendingEqu.length > 0) {
            const p = this.pendingEqu[0];
            const r = this.evalExpr(p.expr);
            throw new Error(`[Line ${p.lineNo}] Cannot resolve EQU '${p.key}': undefined ${r.missing.join(', ')}`);
        }
    }

    /** "count_expr rest": the sub-statement starts at the first token that is a mnemonic or data directive. */
    splitTimes(rest) {
        const re = /\S+/g;
        let m; let first = true;
        while ((m = re.exec(rest)) !== null) {
            if (first) { first = false; continue; } // the first token always belongs to the count
            const up = m[0].toUpperCase();
            if (hasInstruction(up) || PREFIX_MNEMONICS.has(up) || ['DB', 'DW', 'DD'].includes(up)) {
                return { countText: rest.slice(0, m.index).trim(), sub: rest.slice(m.index).trim() };
            }
        }
        throw new Error(`Invalid TIMES syntax: ${rest}`);
    }

    /** One data directive or (possibly prefixed) instruction. */
    parseStatement(text, addr, lineNo, longJumps, emitLine) {
        const sp = text.search(/\s/);
        const mnemonic = (sp === -1 ? text : text.slice(0, sp)).toUpperCase();
        const rest = sp === -1 ? '' : text.slice(sp + 1).trim();

        if (mnemonic === 'DB' || mnemonic === 'DW' || mnemonic === 'DD') {
            emitLine(this.dataLine(mnemonic, rest, addr, lineNo));
            return;
        }

        // `rep movsb` / `lock add ...`: the prefix is its own byte, the instruction follows.
        if (PREFIX_MNEMONICS.has(mnemonic) && rest) {
            emitLine(this.instructionLine(mnemonic, '', addr, lineNo, longJumps));
            const next = rest.search(/\s/);
            const m2 = (next === -1 ? rest : rest.slice(0, next)).toUpperCase();
            const r2 = next === -1 ? '' : rest.slice(next + 1).trim();
            const prev = this.lines[this.lines.length - 1];
            emitLine(this.instructionLine(m2, r2, prev.offset + prev.size, lineNo, longJumps));
            return;
        }
        emitLine(this.instructionLine(mnemonic, rest, addr, lineNo, longJumps));
    }

    dataLine(mnemonic, rest, addr, lineNo) {
        const unit = mnemonic === 'DB' ? 1 : mnemonic === 'DW' ? 2 : 4;
        const items = [];
        let size = 0;
        for (const arg of this.splitOperands(rest)) {
            const str = pureString(arg);
            if (str) {
                const bytes = [...str];
                while (bytes.length % unit !== 0) bytes.push(0); // NASM pads string constants to the unit size
                items.push({ bytes });
                size += bytes.length;
            } else {
                items.push({ expr: this.makeExpr(arg, addr), text: arg });
                size += unit;
            }
        }
        if (items.length === 0) throw new Error(`${mnemonic} needs at least one value`);
        return {
            src: lineNo, offset: addr, size,
            emit: (ctx) => {
                const out = [];
                for (const it of items) {
                    if (it.bytes) { out.push(...it.bytes); continue; }
                    const v = this.requireExpr(it.expr, it.text);
                    const bits = unit * 8;
                    if (v < -(2 ** (bits - 1)) || v > 2 ** bits - 1) ctx.warn(`value ${v} exceeds ${mnemonic} range`);
                    out.push(...(unit === 1 ? [v & 0xFF] : unit === 2 ? le16(v) : le32(v)));
                }
                return out;
            },
        };
    }

    instructionLine(mnemonic, operandText, addr, lineNo, longJumps) {
        if (!hasInstruction(mnemonic)) {
            if (UNSUPPORTED_MNEMONICS.has(mnemonic)) throw new Error(`Instruction '${mnemonic}' is not supported (this assembler targets the 8086/80186)`);
            throw new Error(`Unknown instruction or directive '${mnemonic}'`);
        }
        const operands = this.splitOperands(operandText).map((t) => this.parseOperand(t, addr));
        const rule = findRule(mnemonic, operands, this.curCpu);
        if (!rule) throw new Error(`Unsupported opcode or syntax error: ${mnemonic} ${operandText}`.trim());

        const memWithPrefix = operands.find((o) => o.type === 'mem' && o.mem.prefix);
        const prefix = memWithPrefix ? memWithPrefix.mem.prefix : 0;
        const relaxable = isRelaxableJump(rule);
        const line = {
            src: lineNo, offset: addr, mnemonic, operands, rule, text: `${mnemonic} ${operandText}`.trim(),
            relaxKey: relaxable ? lineNo : null,
            long: relaxable && (longJumps.has(lineNo) || operands[0].hint === 'near'),
            noRelax: relaxable && operands[0].hint === 'short',
        };
        line.size = ruleSize(rule, operands, { offset: addr, long: line.long }) + (prefix ? 1 : 0);
        line.emit = (ctx) => {
            for (const op of operands) this.resolveOperand(op, line.text);
            const bytes = rule.enc(operands, { offset: addr, long: line.long, warn: ctx.warn, sizing: false });
            return prefix ? [prefix, ...bytes] : bytes;
        };
        return line;
    }

    // ------------------------------------------------------------------ relaxation
    /** Promote out-of-range short JMPs to near. Returns true if any jump changed. */
    relax(longJumps) {
        let grew = false;
        for (const line of this.lines) {
            if (line.relaxKey === null || line.relaxKey === undefined || line.long || line.noRelax) continue;
            const r = this.evalExpr(line.operands[0].expr);
            if (r.unresolved) continue; // reported with a proper message in pass 2
            const rel = r.value - (line.offset + 2);
            if (rel < -128 || rel > 127) { longJumps.add(line.relaxKey); grew = true; }
        }
        return grew;
    }

    // ------------------------------------------------------------------ pass 2
    pass2() {
        this.warnings = [];
        const out = [];
        for (const line of this.lines) {
            const ctx = { warn: (msg) => this.warnings.push(`[Line ${line.src}] ${msg}`) };
            let bytes;
            try {
                bytes = line.emit(ctx);
            } catch (err) {
                throw new Error(`[Line ${line.src}] ${err.message}`);
            }
            if (bytes.length !== line.size) {
                throw new Error(`[Line ${line.src}] Size mismatch: ${line.text ?? 'data'} expected ${line.size} bytes but generated ${bytes.length}`);
            }
            for (const b of bytes) out.push(b & 0xFF);
        }
        return new Uint8Array(out);
    }
}

export { Assembler8086 };
