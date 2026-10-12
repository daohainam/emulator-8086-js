// NASM-style integer expressions: tokenizer, precedence-climbing parser and evaluator.
//
//   numbers   : 123  0x1F  1Fh  0b101  101b  0o17  17q  'A'  'AB' (little-endian, up to 4 chars)
//   symbols   : labels / EQU names (case-insensitive), $ (current address), $$ (section base)
//   operators : unary + - ~ !   * / // % %%   + -   << >>   &   ^   |        (lowest precedence last)
//
// An expression that references a symbol the table does not know yet evaluates to
// { value: 0, unresolved: true } instead of failing, so callers can defer it to a later pass.

const BINARY_LEVELS = [
    ['|'],
    ['^'],
    ['&'],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '//', '%', '%%'],
];

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => /[A-Za-z_.?@]/.test(c);
const isIdentChar = (c) => /[A-Za-z0-9_.$#@~?]/.test(c);

const parseNumberToken = (word, text) => {
    const w = word.toLowerCase();
    let m;
    if ((m = /^0x([0-9a-f]+)$/.exec(w))) return parseInt(m[1], 16);
    if ((m = /^([0-9][0-9a-f]*)h$/.exec(w))) return parseInt(m[1], 16);
    if ((m = /^0b([01]+)$/.exec(w))) return parseInt(m[1], 2);
    if ((m = /^([01]+)b$/.exec(w))) return parseInt(m[1], 2);
    if ((m = /^0o([0-7]+)$/.exec(w))) return parseInt(m[1], 8);
    if ((m = /^([0-7]+)[oq]$/.exec(w))) return parseInt(m[1], 8);
    if ((m = /^0d([0-9]+)$/.exec(w))) return parseInt(m[1], 10);
    if ((m = /^([0-9]+)d?$/.exec(w))) return parseInt(m[1], 10);
    throw new Error(`Invalid number '${word}' in expression: ${text}`);
};

const tokenize = (text) => {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (/\s/.test(c)) { i++; continue; }

        if (c === "'" || c === '"') {
            const end = text.indexOf(c, i + 1);
            if (end === -1) throw new Error(`Unterminated string in expression: ${text}`);
            const str = text.slice(i + 1, end);
            if (str.length === 0 || str.length > 4) throw new Error(`Character constant must be 1-4 characters: ${text}`);
            let v = 0;
            for (let k = str.length - 1; k >= 0; k--) v = v * 256 + str.charCodeAt(k);
            tokens.push({ t: 'num', v });
            i = end + 1;
            continue;
        }

        if (isDigit(c)) {
            let j = i + 1;
            while (j < text.length && /[0-9A-Za-z_]/.test(text[j])) j++;
            tokens.push({ t: 'num', v: parseNumberToken(text.slice(i, j), text) });
            i = j;
            continue;
        }

        if (c === '$') {
            if (text[i + 1] === '$') { tokens.push({ t: 'base' }); i += 2; } else { tokens.push({ t: 'here' }); i += 1; }
            continue;
        }

        if (isIdentStart(c)) {
            let j = i + 1;
            while (j < text.length && isIdentChar(text[j])) j++;
            tokens.push({ t: 'sym', name: text.slice(i, j).toUpperCase() });
            i = j;
            continue;
        }

        const two = text.slice(i, i + 2);
        if (['<<', '>>', '//', '%%'].includes(two)) { tokens.push({ t: 'op', op: two }); i += 2; continue; }
        if ('+-*/%&|^~!()'.includes(c)) { tokens.push({ t: 'op', op: c }); i++; continue; }

        throw new Error(`Unexpected character '${c}' in expression: ${text}`);
    }
    return tokens;
};

/**
 * Parse an expression into an AST.
 * @param {string} text
 * @param {(name: string) => string} [qualify] - maps a symbol name (e.g. local label '.LOOP') to its table key
 */
export const parseExpression = (text, qualify = (n) => n) => {
    const tokens = tokenize(text);
    if (tokens.length === 0) throw new Error(`Empty expression`);
    let pos = 0;
    const peek = () => tokens[pos];
    const isOp = (tok, ops) => tok && tok.t === 'op' && ops.includes(tok.op);

    const parseUnary = () => {
        const tok = peek();
        if (isOp(tok, ['+', '-', '~', '!'])) {
            pos++;
            return { t: 'un', op: tok.op, a: parseUnary() };
        }
        return parsePrimary();
    };

    const parsePrimary = () => {
        const tok = tokens[pos++];
        if (!tok) throw new Error(`Unexpected end of expression: ${text}`);
        if (tok.t === 'num') return { t: 'num', v: tok.v };
        if (tok.t === 'here') return { t: 'here' };
        if (tok.t === 'base') return { t: 'base' };
        if (tok.t === 'sym') return { t: 'sym', name: qualify(tok.name) };
        if (isOp(tok, ['('])) {
            const inner = parseLevel(0);
            if (!isOp(tokens[pos], [')'])) throw new Error(`Missing ')' in expression: ${text}`);
            pos++;
            return inner;
        }
        throw new Error(`Unexpected '${tok.op}' in expression: ${text}`);
    };

    const parseLevel = (level) => {
        if (level === BINARY_LEVELS.length) return parseUnary();
        let left = parseLevel(level + 1);
        while (isOp(peek(), BINARY_LEVELS[level])) {
            const op = tokens[pos++].op;
            left = { t: 'bin', op, a: left, b: parseLevel(level + 1) };
        }
        return left;
    };

    const ast = parseLevel(0);
    if (pos < tokens.length) throw new Error(`Unexpected token in expression: ${text}`);
    return ast;
};

const applyBinary = (op, a, b) => {
    switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': case '//': case '%': case '%%':
            if (b === 0) throw new Error('Division by zero in expression');
            if (op === '/') return Math.floor(a / b);   // NASM '/' is unsigned division
            if (op === '//') return Math.trunc(a / b);  // '//' is signed division
            return a % b;                               // '%' / '%%' modulo (unsigned / signed)
        case '<<': return a * 2 ** b;
        case '>>': return Math.floor(a / 2 ** b);
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        default: throw new Error(`Unknown operator ${op}`);
    }
};

/**
 * Evaluate an AST.
 * @param {object} ast
 * @param {{ lookup: (name: string) => number | undefined, here: number, base: number }} env
 * @returns {{ value: number, unresolved: boolean, missing: string[] }} `missing` lists the unknown symbols
 */
export const evaluate = (ast, env) => {
    const missing = [];
    const walk = (n) => {
        switch (n.t) {
            case 'num': return { v: n.v, u: false };
            case 'here': return { v: env.here, u: false };
            case 'base': return { v: env.base, u: false };
            case 'sym': {
                const v = env.lookup(n.name);
                if (v === undefined) { if (!missing.includes(n.name)) missing.push(n.name); return { v: 0, u: true }; }
                return { v, u: false };
            }
            case 'un': {
                const a = walk(n.a);
                const v = n.op === '-' ? -a.v : n.op === '~' ? ~a.v : n.op === '!' ? (a.v ? 0 : 1) : a.v;
                return { v, u: a.u };
            }
            case 'bin': {
                const a = walk(n.a); const b = walk(n.b);
                if (a.u || b.u) return { v: 0, u: true };
                return { v: applyBinary(n.op, a.v, b.v), u: false };
            }
            default: throw new Error(`Bad expression node ${n.t}`);
        }
    };
    const r = walk(ast);
    return { value: r.v, unresolved: r.u, missing };
};

/** Convenience: parse + evaluate in one go. */
export const evalText = (text, env, qualify) => evaluate(parseExpression(text, qualify), env);
