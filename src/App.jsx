import React, { useState, useEffect, useRef, useCallback } from 'react';

// ==========================================
// 1. CONSTANTS & UTILITIES
// ==========================================
const DOS_COLORS = [
    "#000000", "#0000AA", "#00AA00", "#00AAAA", "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
    "#555555", "#5555FF", "#55FF55", "#55FFFF", "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF"
];

const DEFAULT_CODE = `; --- DEMO: MULTICOLOR HELLO 8086 ---
MOV AX, 0x1000
MOV DS, AX

; Store string and colors in RAM (Data Segment)
; Word structure: [8-bit Color Attribute][8-bit ASCII Code]
MOV WORD [0], 0x0C48 ; 'H' (Light Red)
MOV WORD [2], 0x0E65 ; 'e' (Yellow)
MOV WORD [4], 0x0A6C ; 'l' (Light Green)
MOV WORD [6], 0x0B6C ; 'l' (Light Cyan)
MOV WORD [8], 0x096F ; 'o' (Light Blue)
MOV WORD [10], 0x0020 ; ' ' (Space)
MOV WORD [12], 0x0D38 ; '8' (Light Magenta)
MOV WORD [14], 0x0C30 ; '0' (Light Red)
MOV WORD [16], 0x0E38 ; '8' (Yellow)
MOV WORD [18], 0x0A36 ; '6' (Light Green)

MOV AX, 0xB800
MOV ES, AX         ; ES points to Video RAM
MOV SI, 0          ; SI points to source data in RAM
MOV DI, 1990       ; DI points to center of screen (Row 12, Column 35)
MOV CX, 10         ; Loop 10 times (10 characters)

PRINT_LOOP:
MOV AX, [SI]       ; Read 1 Character & Color from RAM
MOV [ES:DI], AX    ; Write directly to VGA screen
ADD SI, 2          ; Move to next character in RAM
ADD DI, 2          ; Move to next screen cell
LOOP PRINT_LOOP

HLT`;

const toHex = (n, pad = 4) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(pad, '0');
const calcPhys = (s, o) => (((s & 0xFFFF) << 4) + (o & 0xFFFF)) & 0xFFFFF;
const calcParity = (val) => {
    let p = 0, v = val & 0xFF;
    while (v) { p ^= (v & 1); v >>= 1; }
    return (p === 0) ? 1 : 0;
};


// ==========================================
// 2. UI SUB-COMPONENTS
// ==========================================

function HeaderControls({ isRunning, isAssembled, initAudio, bootFromDisk, assemble, handleReset, toggleRun, stepUI }) {
    return (
        <div className="flex flex-col md:flex-row justify-between items-center bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-2xl">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-800 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <span className="font-bold text-white text-xl">OS</span>
                </div>
                <div>
                    <h1 className="text-xl font-bold text-white tracking-tight">8086 BOOTABLE EMULATOR</h1>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">Full ISA | VGA | Audio | 64KB Disk | Boot Support</p>
                </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-4 md:mt-0 justify-center">
                <button onClick={initAudio} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-bold transition-all active:scale-95">🔊 Audio</button>
                <button onClick={bootFromDisk} disabled={isRunning} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50">🚀 Boot</button>
                <button onClick={assemble} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold shadow-lg">Assemble</button>
                <button onClick={handleReset} className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95">🔄 Reset</button>
                <button onClick={toggleRun} disabled={!isAssembled} className={`px-4 py-2 text-white rounded-lg text-sm font-bold shadow-lg ${!isAssembled ? "bg-slate-800 opacity-50" : isRunning ? "bg-red-600" : "bg-emerald-600"}`}>
                    {isRunning ? "Stop" : "Run"}
                </button>
                <button onClick={stepUI} disabled={isRunning || !isAssembled} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-bold shadow-lg disabled:opacity-50">Step</button>
            </div>
        </div>
    );
}

function CodeEditor({ code, setCode, setIsAssembled, orgOffset, setOrgOffset }) {
    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col h-[500px] lg:h-[740px]">
            <div className="bg-slate-950/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center">
                <h2 className="text-sm font-bold text-indigo-400 uppercase">Boot Code / Assembler</h2>
                <div className="flex items-center space-x-2 text-[10px]">
                    <span className="text-slate-500">ORG (Origin):</span>
                    <input type="text" value={orgOffset} onChange={ev => setOrgOffset(ev.target.value)} className="w-14 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-amber-400 text-center font-bold focus:outline-none focus:border-amber-500" />
                </div>
            </div>
            <textarea value={code} onChange={(ev) => { setCode(ev.target.value); setIsAssembled(false); }} className="flex-1 bg-transparent p-4 text-emerald-400 font-mono text-[13px] focus:outline-none resize-none leading-relaxed custom-scrollbar" spellCheck="false" />
        </div>
    );
}

function VGAMonitor({ memory, cs, ip }) {
    return (
        <div className="bg-slate-800 p-2 rounded-xl border-4 border-slate-700 shadow-2xl flex flex-col items-center overflow-x-auto">
            <div className="w-full flex justify-between mb-2 px-2 text-[10px] text-slate-400 font-bold min-w-max">
                <span>VGA 80x25 TEXT MODE</span>
                <div className="flex space-x-2">
                     <span className="text-blue-400">CS: {toHex(cs)}</span>
                     <span className="text-amber-400">IP: {toHex(ip)}</span>
                </div>
            </div>
            <div className="bg-black p-2 rounded border border-slate-900 font-mono text-[11px] leading-none whitespace-pre select-none ring-2 ring-black">
                {Array.from({ length: 25 }).map((_, y) => (
                    <div key={y} className="flex h-[1.1em]">
                        {Array.from({ length: 80 }).map((_, x) => {
                            const offset = (y * 80 + x) * 2;
                            const charCode = memory[0xB8000 + offset];
                            const attr = memory[0xB8000 + offset + 1] || 0x07;
                            const fg = DOS_COLORS[attr & 0x0F];
                            const bg = DOS_COLORS[(attr >> 4) & 0x0F];
                            const displayChar = (charCode >= 32 && charCode <= 126) ? String.fromCharCode(charCode) : ' ';
                            return (
                                <span key={x} style={{ color: fg, backgroundColor: bg, width: '1ch', textAlign: 'center', display: 'inline-block' }}>
                                    {displayChar}
                                </span>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}

function DiskViewer({ diskMemory }) {
    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-xl h-40">
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                <h2 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest font-mono">Virtual Disk (Sector 0-31)</h2>
            </div>
            <div className="p-3 overflow-auto flex-1 font-mono text-[9px] bg-slate-950/50 custom-scrollbar grid grid-cols-4 gap-2">
                {Array.from({ length: 32 }).map((_, i) => (
                    <div key={i} className="flex flex-col border border-slate-800 p-1 rounded">
                        <span className="text-slate-600 mb-1">SEC {i.toString().padStart(2, '0')}</span>
                        <div className="flex flex-wrap gap-1">
                            {Array.from({ length: 16 }).map((_, b) => (
                                <span key={b} className={diskMemory[i * 16 + b] !== 0 ? "text-amber-400" : "text-slate-900"}>
                                    {diskMemory[i * 16 + b].toString(16).toUpperCase().padStart(2, '0')}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function MemoryViewer({ memory, memSegStr, setMemSegStr, memOffStr, setMemOffStr }) {
    const seg = parseInt(memSegStr.replace(/0x/i, ''), 16) || 0;
    const off = parseInt(memOffStr.replace(/0x/i, ''), 16) || 0;

    const rows = [];
    for (let r = 0; r < 8; r++) { // Hiển thị 8 dòng (128 bytes)
        const rowOff = (off + r * 16) & 0xFFFF;
        const rowPhys = calcPhys(seg, rowOff);
        const bytes = [];
        const chars = [];
        
        for (let c = 0; c < 16; c++) {
            const addr = rowPhys + c;
            if (addr < 1048576) {
                const val = memory[addr];
                bytes.push(
                    <span key={c} className={val !== 0 ? "text-amber-400" : "text-slate-600"}>
                        {val.toString(16).padStart(2, '0').toUpperCase()}
                    </span>
                );
                chars.push((val >= 32 && val <= 126) ? String.fromCharCode(val) : '.');
            } else {
                bytes.push(<span key={c} className="text-slate-800">00</span>);
                chars.push('.');
            }
        }
        
        rows.push(
            <div key={r} className="flex space-x-3 items-center whitespace-nowrap">
                <span className="text-blue-400 w-16 select-none">{toHex(seg)}:{toHex(rowOff)}</span>
                <span className="flex-1 flex justify-between tracking-widest">{bytes}</span>
                <span className="text-emerald-500 w-16 text-right whitespace-pre">{chars.join('')}</span>
            </div>
        );
    }

    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-xl h-[230px]">
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                <h2 className="text-[10px] font-bold text-fuchsia-400 uppercase tracking-widest font-mono">Memory View</h2>
                <div className="flex space-x-3 text-[10px] items-center">
                    <div className="flex items-center space-x-1">
                        <span className="text-slate-500">SEG:</span>
                        <input type="text" value={memSegStr} onChange={e => setMemSegStr(e.target.value)} className="w-12 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-blue-400 text-center font-bold focus:outline-none focus:border-blue-500" />
                    </div>
                    <div className="flex items-center space-x-1">
                        <span className="text-slate-500">OFF:</span>
                        <input type="text" value={memOffStr} onChange={e => setMemOffStr(e.target.value)} className="w-12 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-amber-400 text-center font-bold focus:outline-none focus:border-amber-500" />
                    </div>
                </div>
            </div>
            <div className="p-3 font-mono text-[11px] bg-slate-950/50 flex flex-col space-y-1.5 overflow-x-auto custom-scrollbar">
                {rows}
            </div>
        </div>
    );
}

function RegistersPanel({ eng, isRunning, handleRegChange, packFlags, hasBootSig, ioLogs }) {
    const e = eng.current;
    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-3 shadow-xl flex flex-col">
            <div className="flex justify-between items-center mb-3 border-b border-slate-800 pb-1">
                <h2 className="text-xs font-bold text-slate-400 uppercase font-mono tracking-tighter">Registers</h2>
                <span className="text-[9px] text-slate-500 italic">Editable</span>
            </div>
            <div className="space-y-1 text-xs mb-3">
                {["AX", "BX", "CX", "DX", "SI", "DI", "SP", "BP", "CS", "DS", "SS", "ES", "IP"].map(reg => (
                    <div key={reg} className="flex justify-between items-center font-mono">
                        <span className="text-blue-400 font-bold">{reg}</span>
                        <input 
                            type="text"
                            defaultValue={toHex(e.reg[reg])}
                            key={`${reg}-${e.reg[reg]}`}
                            onBlur={(ev) => handleRegChange(reg, ev.target.value)}
                            disabled={isRunning}
                            className="w-14 bg-slate-950 text-emerald-400 border border-slate-700 rounded px-1 py-0.5 text-right text-[11px] focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                        />
                    </div>
                ))}
            </div>
            <div className="grid grid-cols-2 gap-1 text-[9px] uppercase font-bold text-slate-500 border-t border-slate-800 pt-2">
                <span>ZF: {e.flags.ZF}</span><span>CF: {e.flags.CF}</span>
                <span>SF: {e.flags.SF}</span><span>OF: {e.flags.OF}</span>
                <span>DF: {e.flags.DF}</span><span>IF: {e.flags.IF}</span>
                <span>PF: {e.flags.PF}</span><span>AF: {e.flags.AF}</span>
            </div>
            
            <div className="mt-2 text-[11px] font-mono text-center text-fuchsia-400 bg-slate-950/80 py-1 rounded border border-slate-800">
                {packFlags().toString(2).padStart(16, '0').replace(/(.{4})/g, '$1 ').trim()}
            </div>
            
            <div className="mt-4 pt-4 border-t border-slate-800">
                <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">BIOS Status</div>
                <div className="text-[10px] space-y-1">
                    <div className="flex justify-between"><span>Boot Sig:</span> <span className={hasBootSig ? "text-emerald-500" : "text-red-500"}>{hasBootSig ? "0xAA55" : "MISSING"}</span></div>
                    <div className="flex justify-between"><span>Audio:</span> <span className={e.beeping ? "text-amber-400" : "text-slate-600"}>{e.beeping ? "ON" : "OFF"}</span></div>
                </div>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-800 text-[9px] text-slate-600 font-mono">
                System Logs:
                <div className="h-24 overflow-hidden mt-1 opacity-50 custom-scrollbar">
                     {ioLogs.slice(-5).map((log, i) => <div key={i}>{">"} {log}</div>)}
                </div>
            </div>
        </div>
    );
}

// ==========================================
// 3. MAIN APP & CPU CORE LOGIC
// ==========================================

export default function Emulator8086() {
    const [code, setCode] = useState(DEFAULT_CODE);
    const [errorMessage, setErrorMessage] = useState(null);
    const [isRunning, setIsRunning] = useState(false);
    const [isAssembled, setIsAssembled] = useState(false);
    
    // States cho Origin Offset và Memory Viewer
    const [orgOffset, setOrgOffset] = useState("0x1000"); 
    const [memSegStr, setMemSegStr] = useState("0x1000"); 
    const [memOffStr, setMemOffStr] = useState("0x0000");
    
    const [ioLogs, setIoLogs] = useState([]);
    const [, setTick] = useState(0);
    const forceRender = () => setTick(t => t + 1);

    const isRunningRef = useRef(false);
    const requestRef = useRef(null);
    const audioCtxRef = useRef(null);
    const oscRef = useRef(null);

    const eng = useRef({
        reg: { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, SP: 0xFFFE, BP: 0, CS: 0, DS: 0, SS: 0, ES: 0, IP: 0 },
        flags: { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 },
        mem: new Uint8Array(1048576),
        disk: new Uint8Array(65536),
        ioPorts: {},
        insts: [],
        labels: {},
        diskSectorSelect: 0,
        t2Div: 0,
        t2High: false,
        freq: 0,
        beeping: false,
        bootMode: false
    });

    const addLog = (msg) => setIoLogs(prev => [...prev, msg].slice(-20));

    const handleRegChange = (reg, valStr) => {
        let val = parseInt(valStr.replace(/0x/i, ''), 16);
        if (isNaN(val)) val = 0;
        eng.current.reg[reg] = val & 0xFFFF;
        forceRender();
    };

    const handleReset = () => {
        setIsRunning(false);
        isRunningRef.current = false;
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        const e = eng.current;
        Object.keys(e.reg).forEach(k => e.reg[k] = 0);
        e.reg.SP = 0xFFFE;
        e.reg.IP = parseInt(orgOffset.replace(/0x/i, ''), 16) || 0;
        e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 };
        e.mem.fill(0); 
        setErrorMessage(null);
        forceRender();
    };

    const resetCPU = () => {
        const e = eng.current;
        Object.keys(e.reg).forEach(k => e.reg[k] = 0);
        e.reg.SP = 0xFFFE;
        e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 };
        e.mem.fill(0);
        e.ioPorts = {};
        e.t2Div = 0;
        e.t2High = false;
        e.freq = 0;
        e.beeping = false;
        e.bootMode = false;
        setErrorMessage(null);
        setIoLogs([]);
        stopAudio();
    };

    const initAudio = () => {
        if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    };

    const playBeep = (freq) => {
        stopAudio();
        if (!audioCtxRef.current) return;
        const ctx = audioCtxRef.current;
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        const gain = ctx.createGain();
        gain.gain.value = 0.1;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        oscRef.current = osc;
    };

    const stopAudio = () => {
        if (oscRef.current) { try { oscRef.current.stop(); } catch (e) { } oscRef.current = null; }
    };

    const handleKeyDown = (e) => {
        if (e.key.length === 1) {
            eng.current.mem[0x0400] = e.key.charCodeAt(0);
            eng.current.ioPorts[0x60] = e.key.charCodeAt(0);
            forceRender();
        }
    };

    const resolveOffset = (s) => {
        const e = eng.current;
        s = s.trim().toUpperCase();
        if (s.startsWith("BYTE") || s.startsWith("WORD")) s = s.replace(/^(BYTE|WORD)\s+/, "");
        s = s.replace(/^\[|\]$/g, "").trim();
        if (s.includes(":")) s = s.split(":")[1];
        if (e.reg[s] !== undefined) return e.reg[s];
        if (s.startsWith("0X")) return parseInt(s, 16);
        const parsed = parseInt(s, 10);
        return isNaN(parsed) ? 0 : parsed;
    };

    const readMemWord = (phys) => {
        if (phys < 0 || phys >= 1048575) throw new Error(`Memory bounds at ${toHex(phys, 5)}`);
        return (eng.current.mem[phys + 1] << 8) | eng.current.mem[phys];
    };

    const writeMemWord = (phys, val) => {
        if (phys < 0 || phys >= 1048575) throw new Error(`Memory bounds at ${toHex(phys, 5)}`);
        eng.current.mem[phys] = val & 0xFF;
        eng.current.mem[phys + 1] = (val >> 8) & 0xFF;
    };

    const getOpVal = (op) => {
        const e = eng.current;
        op = op.toUpperCase();
        if (e.labels[op] !== undefined) return e.labels[op];
        if (op.includes("[")) {
            let seg = e.reg.DS;
            if (op.includes("ES:")) seg = e.reg.ES;
            const innerMatch = op.match(/\[(.*)\]/);
            if (!innerMatch) return 0;
            const phys = calcPhys(seg, resolveOffset(innerMatch[1]));
            return op.includes("BYTE") ? e.mem[phys] : readMemWord(phys);
        }
        if (e.reg[op] !== undefined) return e.reg[op];
        if (op.startsWith("0X")) return parseInt(op, 16);
        const parsed = parseInt(op, 10);
        return isNaN(parsed) ? 0 : parsed;
    };

    const writeOpVal = (dst, val) => {
        const e = eng.current;
        dst = dst.toUpperCase();
        if (dst.includes("[")) {
            let seg = e.reg.DS;
            if (dst.includes("ES:")) seg = e.reg.ES;
            const innerMatch = dst.match(/\[(.*)\]/);
            if (!innerMatch) return;
            const phys = calcPhys(seg, resolveOffset(innerMatch[1]));
            if (dst.includes("BYTE")) e.mem[phys] = val & 0xFF;
            else writeMemWord(phys, val & 0xFFFF);
        } else if (e.reg[dst] !== undefined) {
            e.reg[dst] = val & 0xFFFF;
        } else {
            throw new Error(`Invalid destination: ${dst}`);
        }
    };

    const push16 = (val) => { const e = eng.current; e.reg.SP = (e.reg.SP - 2) & 0xFFFF; writeMemWord(calcPhys(e.reg.SS, e.reg.SP), val); };
    const pop16 = () => { const e = eng.current; const val = readMemWord(calcPhys(e.reg.SS, e.reg.SP)); e.reg.SP = (e.reg.SP + 2) & 0xFFFF; return val; };

    const packFlags = () => {
        const f = eng.current.flags; let r = 0;
        if (f.CF) r |= (1 << 0); if (f.PF) r |= (1 << 2); if (f.AF) r |= (1 << 4);
        if (f.ZF) r |= (1 << 6); if (f.SF) r |= (1 << 7); if (f.IF) r |= (1 << 9);
        if (f.DF) r |= (1 << 10); if (f.OF) r |= (1 << 11);
        return r;
    };

    const unpackFlags = (r) => {
        const f = eng.current.flags;
        f.CF = (r & (1 << 0)) ? 1 : 0; f.PF = (r & (1 << 2)) ? 1 : 0; f.AF = (r & (1 << 4)) ? 1 : 0;
        f.ZF = (r & (1 << 6)) ? 1 : 0; f.SF = (r & (1 << 7)) ? 1 : 0; f.IF = (r & (1 << 9)) ? 1 : 0;
        f.DF = (r & (1 << 10)) ? 1 : 0; f.OF = (r & (1 << 11)) ? 1 : 0;
    };

    const writeToVGA = (c) => {
        const e = eng.current;
        for (let i = 0; i < 2000; i++) {
            if (e.mem[0xB8000 + i * 2] === 0) { e.mem[0xB8000 + i * 2] = c.charCodeAt(0); e.mem[0xB8000 + i * 2 + 1] = 0x07; break; }
        }
    };

    const assemble = () => {
        resetCPU();
        const e = eng.current;
        const startIP = parseInt(orgOffset.replace(/0x/i, ''), 16) || 0;
        e.reg.IP = startIP;
        e.insts = new Array(startIP).fill({ op: "NOP", args: [], originalLine: 0 });
        e.labels = {};
        
        const lines = code.split('\n');
        let idx = startIP;
        for (let i = 0; i < lines.length; i++) {
            let l = lines[i].split(';')[0].trim();
            if (!l) continue;
            if (l.endsWith(':')) { e.labels[l.replace(/:$/, '').toUpperCase()] = idx; continue; }
            const firstSpace = l.indexOf(' ');
            let op = firstSpace !== -1 ? l.substring(0, firstSpace).trim().toUpperCase() : l.toUpperCase();
            let argsStr = firstSpace !== -1 ? l.substring(firstSpace).trim() : "";
            let args = argsStr ? argsStr.split(',').map(a => a.trim()) : [];
            e.insts.push({ originalLine: i + 1, op, args });
            idx++;
        }
        setIsAssembled(true);
        forceRender();
    };

    const executeStep = () => {
        const e = eng.current; const r = e.reg; const f = e.flags;

        if (e.bootMode) {
            const opCode = e.mem[r.IP];
            if (opCode === 0xB4) { r.AX = (r.AX & 0x00FF) | (e.mem[r.IP + 1] << 8); r.IP += 2; }
            else if (opCode === 0xB0) { r.AX = (r.AX & 0xFF00) | e.mem[r.IP + 1]; r.IP += 2; }
            else if (opCode === 0xCD) {
                if (e.mem[r.IP + 1] === 0x10 && ((r.AX >> 8) & 0xFF) === 0x0E) writeToVGA(String.fromCharCode(r.AX & 0xFF));
                r.IP += 2;
            }
            else if (opCode === 0xF4) { return false; }
            else { throw new Error(`Opcode error 0x${opCode.toString(16).toUpperCase()} at 0x${r.IP.toString(16).toUpperCase()}`); }
            return true;
        }

        if (r.IP >= e.insts.length) return false;
        const inst = e.insts[r.IP];
        if (inst && inst.op === "NOP" && inst.originalLine === 0) { r.IP++; return true; }

        let nextIP = r.IP + 1;
        let op = inst.op;
        let args = inst.args;
        let prefix = null;

        if (["REP", "REPE", "REPZ", "REPNE", "REPNZ"].includes(op)) {
            if (r.CX === 0) { r.IP = nextIP; return true; }
            prefix = op; op = args.length > 0 ? args[0].toUpperCase() : "NOP"; args = args.slice(1);
        }
        
        switch (op) {
            case "MOV": writeOpVal(args[0], getOpVal(args[1])); break;
            case "XCHG": { const t = getOpVal(args[0]); writeOpVal(args[0], getOpVal(args[1])); writeOpVal(args[1], t); break; }
            case "LEA": {
                let inner = args[1].replace(/[\[\]]/g, '').trim();
                if (inner.includes(':')) inner = inner.split(':')[1];
                writeOpVal(args[0], resolveOffset(inner)); break;
            }
            case "LDS": case "LES": {
                const addr = calcPhys(r.DS, resolveOffset(args[1].replace(/[\[\]]/g, '')));
                writeOpVal(args[0], readMemWord(addr));
                r[op === "LDS" ? "DS" : "ES"] = readMemWord(addr + 2); break;
            }
            case "XLAT": r.AX = (r.AX & 0xFF00) | e.mem[calcPhys(r.DS, (r.BX + (r.AX & 0xFF)) & 0xFFFF)]; break;
            case "ADD": case "SUB": case "CMP": case "ADC": case "SBB": {
                const v1 = getOpVal(args[0]); const v2 = getOpVal(args[1]); let res = 0;
                if (op === "ADD") { res = v1 + v2; f.CF = res > 0xFFFF ? 1 : 0; f.AF = ((v1 ^ v2 ^ res) & 0x10) ? 1 : 0; }
                if (op === "SUB" || op === "CMP") { res = v1 - v2; f.CF = v1 < v2 ? 1 : 0; f.AF = ((v1 ^ v2 ^ res) & 0x10) ? 1 : 0; }
                if (op === "ADC") { res = v1 + v2 + f.CF; f.CF = res > 0xFFFF ? 1 : 0; }
                if (op === "SBB") { res = v1 - v2 - f.CF; f.CF = v1 < (v2 + f.CF) ? 1 : 0; }
                if (op !== "CMP") writeOpVal(args[0], res);
                f.ZF = (res & 0xFFFF) === 0 ? 1 : 0; f.SF = (res & 0x8000) ? 1 : 0; f.PF = calcParity(res); break;
            }
            case "MUL": case "IMUL": {
                const u1 = r.AX & 0xFFFF; const u2 = getOpVal(args[0]) & 0xFFFF;
                if (op === "MUL") { const ur = (u1 * u2) >>> 0; r.AX = ur & 0xFFFF; r.DX = (ur >>> 16) & 0xFFFF; f.CF = f.OF = r.DX !== 0 ? 1 : 0; } 
                else { const sr = ((u1 << 16) >> 16) * ((u2 << 16) >> 16); r.AX = sr & 0xFFFF; r.DX = (sr >> 16) & 0xFFFF; f.CF = f.OF = ((r.AX & 0x8000) ? r.DX === 0xFFFF : r.DX === 0) ? 0 : 1; }
                break;
            }
            case "DIV": case "IDIV": {
                const d = getOpVal(args[0]) & 0xFFFF; if (d === 0) throw new Error("Divide by zero");
                if (op === "DIV") { const dvnd = ((r.DX & 0xFFFF) * 0x10000) + (r.AX & 0xFFFF); const q = Math.floor(dvnd / d); if (q > 0xFFFF) throw new Error("Divide overflow"); r.AX = q & 0xFFFF; r.DX = (dvnd % d) & 0xFFFF; } 
                else { const dvnd = (r.DX << 16) | (r.AX & 0xFFFF); const ds = (d << 16) >> 16; const q = Math.trunc(dvnd / ds); if (q > 32767 || q < -32768) throw new Error("Divide overflow"); r.AX = q & 0xFFFF; r.DX = (dvnd % ds) & 0xFFFF; }
                break;
            }
            case "INC": case "DEC": { const v = op === "INC" ? getOpVal(args[0]) + 1 : getOpVal(args[0]) - 1; writeOpVal(args[0], v); f.ZF = (v & 0xFFFF) === 0 ? 1 : 0; f.SF = (v & 0x8000) ? 1 : 0; f.PF = calcParity(v); break; }
            case "NEG": { const v = getOpVal(args[0]); const nr = (0 - v) & 0xFFFF; writeOpVal(args[0], nr); f.CF = v === 0 ? 0 : 1; f.ZF = nr === 0 ? 1 : 0; f.SF = (nr & 0x8000) ? 1 : 0; f.PF = calcParity(nr); break; }
            case "AND": case "OR": case "XOR": {
                const l1 = getOpVal(args[0]); const l2 = getOpVal(args[1]); let lr = 0;
                if (op === "AND") lr = l1 & l2; else if (op === "OR") lr = l1 | l2; else lr = l1 ^ l2;
                writeOpVal(args[0], lr); f.CF = 0; f.OF = 0; f.ZF = (lr & 0xFFFF) === 0 ? 1 : 0; f.SF = (lr & 0x8000) ? 1 : 0; f.PF = calcParity(lr); break;
            }
            case "TEST": { const res = getOpVal(args[0]) & getOpVal(args[1]); f.CF = 0; f.OF = 0; f.ZF = (res & 0xFFFF) === 0 ? 1 : 0; f.SF = (res & 0x8000) ? 1 : 0; f.PF = calcParity(res); break; }
            case "NOT": writeOpVal(args[0], ~getOpVal(args[0]) & 0xFFFF); break;
            case "SHL": case "SAL": case "SHR": case "SAR": case "ROL": case "ROR": case "RCL": case "RCR": {
                let sv = getOpVal(args[0]); const sc = getOpVal(args[1]) & 0x1F;
                for (let i = 0; i < sc; i++) {
                    if (op === "SHL" || op === "SAL") { f.CF = (sv & 0x8000) ? 1 : 0; sv = (sv << 1) & 0xFFFF; }
                    else if (op === "SHR") { f.CF = sv & 1; sv = (sv >> 1) & 0xFFFF; }
                    else if (op === "SAR") { f.CF = sv & 1; sv = (sv & 0x8000) | ((sv >> 1) & 0x7FFF); }
                    else if (op === "ROL") { f.CF = (sv & 0x8000) ? 1 : 0; sv = ((sv << 1) | f.CF) & 0xFFFF; }
                    else if (op === "ROR") { f.CF = sv & 1; sv = ((sv >> 1) | (f.CF << 15)) & 0xFFFF; }
                    else if (op === "RCL") { let oc = f.CF; f.CF = (sv & 0x8000) ? 1 : 0; sv = ((sv << 1) | oc) & 0xFFFF; }
                    else if (op === "RCR") { let oc = f.CF; f.CF = sv & 1; sv = ((sv >> 1) | (oc << 15)) & 0xFFFF; }
                }
                writeOpVal(args[0], sv); f.ZF = sv === 0 ? 1 : 0; f.SF = (sv & 0x8000) ? 1 : 0; f.PF = calcParity(sv); break;
            }
            case "MOVSB": case "MOVSW": case "MOVS": case "LODSB": case "LODSW": case "LODS": case "STOSB": case "STOSW": case "STOS": case "CMPSB": case "CMPSW": case "CMPS": case "SCASB": case "SCASW": case "SCAS": {
                const sz = (op.endsWith("W") || args.includes("WORD")) ? 2 : 1; const dir = f.DF === 0 ? sz : -sz;
                if (op.startsWith("MOVS")) {
                    const s = calcPhys(r.DS, r.SI); const d = calcPhys(r.ES, r.DI);
                    if (sz === 1) e.mem[d] = e.mem[s]; else writeMemWord(d, readMemWord(s));
                    r.SI = (r.SI + dir) & 0xFFFF; r.DI = (r.DI + dir) & 0xFFFF;
                } else if (op.startsWith("LODS")) {
                    const s = calcPhys(r.DS, r.SI);
                    if (sz === 1) r.AX = (r.AX & 0xFF00) | e.mem[s]; else r.AX = readMemWord(s);
                    r.SI = (r.SI + dir) & 0xFFFF;
                } else if (op.startsWith("STOS")) {
                    const d = calcPhys(r.ES, r.DI);
                    if (sz === 1) e.mem[d] = r.AX & 0xFF; else writeMemWord(d, r.AX);
                    r.DI = (r.DI + dir) & 0xFFFF;
                } else if (op.startsWith("CMPS")) {
                    const s = calcPhys(r.DS, r.SI); const d = calcPhys(r.ES, r.DI);
                    const v1 = sz === 1 ? e.mem[s] : readMemWord(s); const v2 = sz === 1 ? e.mem[d] : readMemWord(d);
                    const res = v1 - v2; f.ZF = (res & (sz===1?0xFF:0xFFFF)) === 0 ? 1 : 0; f.CF = v1 < v2 ? 1 : 0; f.PF = calcParity(res);
                    r.SI = (r.SI + dir) & 0xFFFF; r.DI = (r.DI + dir) & 0xFFFF;
                } else if (op.startsWith("SCAS")) {
                    const d = calcPhys(r.ES, r.DI);
                    const v1 = sz === 1 ? r.AX & 0xFF : r.AX; const v2 = sz === 1 ? e.mem[d] : readMemWord(d);
                    const res = v1 - v2; f.ZF = (res & (sz===1?0xFF:0xFFFF)) === 0 ? 1 : 0; f.CF = v1 < v2 ? 1 : 0; f.PF = calcParity(res);
                    r.DI = (r.DI + dir) & 0xFFFF;
                }
                break;
            }
            case "AAA": if ((r.AX & 0x0F) > 9 || f.AF === 1) { r.AX = (r.AX + 6) & 0xFFFF; r.AX = (((r.AX >> 8) + 1) << 8) | (r.AX & 0xFF); f.AF = 1; f.CF = 1; } else { f.AF = 0; f.CF = 0; } r.AX &= 0xFF0F; break;
            case "AAS": if ((r.AX & 0x0F) > 9 || f.AF === 1) { r.AX = (r.AX - 6) & 0xFFFF; r.AX = (((r.AX >> 8) - 1) << 8) | (r.AX & 0xFF); f.AF = 1; f.CF = 1; } else { f.AF = 0; f.CF = 0; } r.AX &= 0xFF0F; break;
            case "AAM": { const al = r.AX & 0xFF; r.AX = (Math.floor(al / 10) << 8) | (al % 10); break; }
            case "AAD": r.AX = (((r.AX >> 8) & 0xFF) * 10 + (r.AX & 0xFF)) & 0xFF; break;
            case "DAA": { let al = r.AX & 0xFF; let oldCf = f.CF; if ((al & 0x0F) > 9 || f.AF === 1) { al += 6; f.CF = oldCf | (al > 0xFF ? 1 : 0); f.AF = 1; } else f.AF = 0; if (al > 0x9F || oldCf === 1) { al += 0x60; f.CF = 1; } else f.CF = 0; r.AX = (r.AX & 0xFF00) | (al & 0xFF); break; }
            case "DAS": { let al = r.AX & 0xFF; let oldCf = f.CF; if ((al & 0x0F) > 9 || f.AF === 1) { al -= 6; f.CF = oldCf | (al < 0 ? 1 : 0); f.AF = 1; } else f.AF = 0; if (al > 0x9F || oldCf === 1) { al -= 0x60; f.CF = 1; } r.AX = (r.AX & 0xFF00) | (al & 0xFF); break; }
            case "CBW": r.AX = (r.AX & 0x80) ? (0xFF00 | (r.AX & 0xFF)) : (r.AX & 0xFF); break;
            case "CWD": r.DX = (r.AX & 0x8000) ? 0xFFFF : 0x0000; break;
            case "OUT": {
                const port = getOpVal(args[0]); const val = getOpVal(args[1]) & 0xFF;
                if (port === 0x70) e.diskSectorSelect = val % 256;
                if (port === 0x71) {
                    const rAddr = calcPhys(r.DS, r.BX); const dAddr = e.diskSectorSelect * 16;
                    if (val === 1) for(let i=0; i<16; i++) e.mem[rAddr + i] = e.disk[dAddr + i];
                    if (val === 2) for(let i=0; i<16; i++) e.disk[dAddr + i] = e.mem[rAddr + i];
                }
                if (port === 0x42) {
                    if (!e.t2High) { e.t2Div = val; e.t2High = true; }
                    else { e.t2Div |= (val << 8); e.t2High = false; if (e.t2Div > 0) e.freq = 1193182 / e.t2Div; }
                }
                if (port === 0x61) {
                    const enable = (val & 0x03) === 0x03;
                    if (enable && !e.beeping) { e.beeping = true; playBeep(e.freq); } else if (!enable && e.beeping) { e.beeping = false; stopAudio(); }
                }
                addLog(`OUT 0x${port.toString(16).toUpperCase()}: 0x${val.toString(16).toUpperCase()}`);
                break;
            }
            case "IN": writeOpVal(args[0], e.ioPorts[getOpVal(args[1])] || 0); break;
            case "LOOP": r.CX = (r.CX - 1) & 0xFFFF; if (r.CX !== 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "LOOPE": case "LOOPZ": r.CX = (r.CX - 1) & 0xFFFF; if (r.CX !== 0 && f.ZF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "LOOPNE": case "LOOPNZ": r.CX = (r.CX - 1) & 0xFFFF; if (r.CX !== 0 && f.ZF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JZ": case "JE": if (f.ZF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JNZ": case "JNE": if (f.ZF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JA": case "JNBE": if (f.CF === 0 && f.ZF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JAE": case "JNB": case "JNC": if (f.CF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JB": case "JNAE": case "JC": if (f.CF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JBE": case "JNA": if (f.CF === 1 || f.ZF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JG": case "JNLE": if (f.ZF === 0 && f.SF === f.OF) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JGE": case "JNL": if (f.SF === f.OF) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JL": case "JNGE": if (f.SF !== f.OF) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JLE": case "JNG": if (f.ZF === 1 || f.SF !== f.OF) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JP": case "JPE": if (f.PF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JNP": case "JPO": if (f.PF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JCXZ": if (r.CX === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JO": if (f.OF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JNO": if (f.OF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JS": if (f.SF === 1) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JNS": if (f.SF === 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "JMP": nextIP = e.labels[args[0].toUpperCase()]; break;
            case "CALL": push16(nextIP); nextIP = e.labels[args[0].toUpperCase()]; break;
            case "RET": nextIP = pop16(); if (args.length > 0) r.SP = (r.SP + getOpVal(args[0])) & 0xFFFF; break;
            case "RETF": nextIP = pop16(); r.CS = pop16(); if (args.length > 0) r.SP = (r.SP + getOpVal(args[0])) & 0xFFFF; break;
            case "PUSH": push16(getOpVal(args[0])); break;
            case "POP": writeOpVal(args[0], pop16()); break;
            case "PUSHA": { const sp = r.SP; push16(r.AX); push16(r.CX); push16(r.DX); push16(r.BX); push16(sp); push16(r.BP); push16(r.SI); push16(r.DI); break; }
            case "POPA": r.DI = pop16(); r.SI = pop16(); r.BP = pop16(); pop16(); r.BX = pop16(); r.DX = pop16(); r.CX = pop16(); r.AX = pop16(); break;
            case "PUSHF": push16(packFlags()); break;
            case "POPF": unpackFlags(pop16()); break;
            case "LAHF": r.AX = (r.AX & 0xFF00) | (packFlags() & 0xFF); break;
            case "SAHF": unpackFlags((packFlags() & 0xFF00) | (r.AX & 0xFF)); break;
            case "STC": f.CF = 1; break; case "CLC": f.CF = 0; break; case "CMC": f.CF = 1 - f.CF; break;
            case "STD": f.DF = 1; break; case "CLD": f.DF = 0; break;
            case "STI": f.IF = 1; break; case "CLI": f.IF = 0; break;
            case "INT": {
                const vec = getOpVal(args[0]);
                push16(packFlags()); push16(r.CS); push16(nextIP);
                nextIP = readMemWord(vec * 4); r.CS = readMemWord(vec * 4 + 2); break;
            }
            case "INTO": {
                if (f.OF === 1) { push16(packFlags()); push16(r.CS); push16(nextIP); nextIP = readMemWord(4 * 4); r.CS = readMemWord(4 * 4 + 2); }
                break;
            }
            case "IRET": nextIP = pop16(); r.CS = pop16(); unpackFlags(pop16()); break;
            case "WAIT": case "LOCK": case "ESC": case "NOP": break;
            case "HLT": return false;
            default: break;
        }
        
        if (prefix) {
            r.CX = (r.CX - 1) & 0xFFFF;
            let repeat = r.CX !== 0;
            if (prefix === "REPE" || prefix === "REPZ") repeat = repeat && f.ZF === 1;
            if (prefix === "REPNE" || prefix === "REPNZ") repeat = repeat && f.ZF === 0;
            if (repeat) nextIP = r.IP;
        }

        r.IP = nextIP;
        return true;
    };

    const stepUI = () => {
        try { executeStep(); forceRender(); } catch (ex) { setErrorMessage(ex.message); setIsRunning(false); isRunningRef.current = false; }
    };

    const runLoop = useCallback(() => {
        if (!isRunningRef.current) return;
        let ok = true;
        try { for (let i = 0; i < 20; i++) { if (!executeStep()) { ok = false; break; } } } 
        catch (ex) { setErrorMessage(ex.message); ok = false; }
        forceRender();
        if (ok) requestRef.current = requestAnimationFrame(runLoop);
        else { setIsRunning(false); isRunningRef.current = false; }
    }, []);

    const toggleRun = () => {
        if (isRunning) {
            setIsRunning(false); isRunningRef.current = false;
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        } else {
            setIsRunning(true); isRunningRef.current = true;
            requestRef.current = requestAnimationFrame(runLoop);
        }
    };

    const bootFromDisk = () => {
        const e = eng.current;
        if (e.disk[510] !== 0x55 || e.disk[511] !== 0xAA) { setErrorMessage("Boot signature 0xAA55 not found!"); return; }
        resetCPU();
        for (let i = 0; i < 512; i++) e.mem[0x7C00 + i] = e.disk[i];
        e.reg.IP = 0x7C00; e.reg.CS = 0x0000; e.bootMode = true;
        addLog("BIOS: Booting from disk at 0x7C00...");
        setIsAssembled(true); setIsRunning(true); isRunningRef.current = true;
        requestRef.current = requestAnimationFrame(runLoop);
    };

    useEffect(() => {
        return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); stopAudio(); };
    }, []);

    const e = eng.current;
    const hasBootSig = e.disk[510] === 0x55 && e.disk[511] === 0xAA;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 p-4 font-mono selection:bg-blue-500/30" onKeyDown={handleKeyDown} tabIndex="0">
            <div className="max-w-[1400px] mx-auto space-y-6 outline-none">
                
                <HeaderControls 
                    isRunning={isRunning} isAssembled={isAssembled} initAudio={initAudio} 
                    bootFromDisk={bootFromDisk} assemble={assemble} handleReset={handleReset} 
                    toggleRun={toggleRun} stepUI={stepUI} 
                />

                {errorMessage && (
                    <div className="bg-red-950/50 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg shadow-lg flex">
                        <p className="font-bold mr-2">SYSTEM HALT:</p> {errorMessage}
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    <div className="lg:col-span-4 space-y-4 flex flex-col">
                        <CodeEditor code={code} setCode={setCode} setIsAssembled={setIsAssembled} orgOffset={orgOffset} setOrgOffset={setOrgOffset} />
                    </div>

                    <div className="lg:col-span-6 space-y-4">
                        <VGAMonitor memory={e.mem} cs={e.reg.CS} ip={e.reg.IP} />
                        <MemoryViewer memory={e.mem} memSegStr={memSegStr} setMemSegStr={setMemSegStr} memOffStr={memOffStr} setMemOffStr={setMemOffStr} />
                        <DiskViewer diskMemory={e.disk} />
                    </div>

                    <div className="lg:col-span-2 space-y-4">
                        <RegistersPanel eng={eng} isRunning={isRunning} handleRegChange={handleRegChange} packFlags={packFlags} hasBootSig={hasBootSig} ioLogs={ioLogs} />
                    </div>
                </div>
            </div>
            <style>{`
                .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            `}</style>
        </div>
    );
}