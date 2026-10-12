// Hardware conformance: SingleStepTests/8086 vectors.
//
//  * fixtures/singlestep/sample.json  - three hand-written vectors that always run (validates this runner).
//  * test/data/8086/v1/*.json[.gz]    - the real suite. Download it yourself (it is large and untrusted data,
//    so it is git-ignored) from https://github.com/SingleStepTests/8086 and point SINGLESTEP_DIR at the
//    directory holding the per-opcode files + metadata.json. Skipped automatically when absent.
//
// Env: SINGLESTEP_DIR (default test/data/8086/v1), SINGLESTEP_MIN_PASS (default 0.99),
//      SINGLESTEP_LIMIT (max vectors per opcode file, default all), SINGLESTEP_KNOWN (path to JSON array of
//      opcode files exempt from the threshold).
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRunner, flagsMaskFor, listTestFiles, readMetadata, readTestFile } from './singlestep.js';
import { makeRegistrar } from './helpers.js';

const OPEN = new Set([]);
const t = makeRegistrar(OPEN);

describe('SingleStepTests runner', () => {
    t('hand-written fixture vectors pass', () => {
        const { runCase } = createRunner();
        const cases = readTestFile(path.join(import.meta.dirname, 'fixtures', 'singlestep', 'sample.json'));
        const failures = cases.map((tc) => [tc.name, runCase(tc)]).filter(([, p]) => p.length);
        expect(failures).toEqual([]);
    });
});

const dataDir = process.env.SINGLESTEP_DIR ?? path.join(import.meta.dirname, 'data', '8086', 'v1');
const files = listTestFiles(dataDir);
const minPass = Number(process.env.SINGLESTEP_MIN_PASS ?? 0.99);
const limit = Number(process.env.SINGLESTEP_LIMIT ?? Infinity);
const known = new Set(process.env.SINGLESTEP_KNOWN && fs.existsSync(process.env.SINGLESTEP_KNOWN)
    ? JSON.parse(fs.readFileSync(process.env.SINGLESTEP_KNOWN, 'utf8')) : []);

describe.skipIf(files.length === 0)(`SingleStepTests/8086 (${dataDir})`, { timeout: 600000 }, () => {
    const metadata = readMetadata(dataDir);
    const { runCase } = createRunner();
    it.each(files)('%s', (file) => {
        const cases = readTestFile(path.join(dataDir, file)).slice(0, limit);
        const mask = flagsMaskFor(file, metadata);
        let pass = 0;
        const samples = [];
        for (const tc of cases) {
            const problems = runCase(tc, mask);
            if (problems.length === 0) pass++;
            else if (samples.length < 3) samples.push(`${tc.name} [${tc.bytes.map((b) => b.toString(16)).join(' ')}]: ${problems.join('; ')}`);
        }
        const rate = pass / cases.length;
        if (known.has(file)) return;
        expect(rate, `${file}: ${pass}/${cases.length} passed\n${samples.join('\n')}`).toBeGreaterThanOrEqual(minPass);
    });
});
