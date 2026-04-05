import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Assembler8086 } from './Assembler8086.js';

// ==========================================
// 1. CONSTANTS & UTILITIES
// ==========================================
const DOS_COLORS = [
    "#000000", "#0000AA", "#00AA00", "#00AAAA", "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
    "#555555", "#5555FF", "#55FF55", "#55FFFF", "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF"
];

// --- HARDWARE CONSTANTS ---
const ADDR_SPACE     = 1048576; // Total address space (1 MB)
const RAM_SIZE       = 65536;   // Main RAM size (64 KB)
const DISK_SIZE      = 65536;   // Virtual disk size (64 KB)
const SECTOR_SIZE    = 512;     // Standard disk sector size

const VGA_BASE       = 0xB8000; // VGA text mode VRAM base address
const VGA_COLS       = 80;      // VGA text mode columns
const VGA_ROWS       = 25;      // VGA text mode rows
const VGA_SIZE       = VGA_COLS * VGA_ROWS * 2; // 4000 Bytes

const BIOS_BASE      = 0xF0000; // BIOS ROM base address
const BIOS_SIZE      = 32768;   // BIOS ROM size (32 KB)

const BOOT_LOAD_ADDR = 0x7C00;  // BIOS boot sector load address
const INITIAL_SP     = 0xFFFE;  // Initial stack pointer value
const PC_TIMER_FREQ  = 1193182; // PC Timer base frequency in Hz (1.193182 MHz)
const KBD_BUF_ADDR   = 0x0400;  // BIOS keyboard buffer address

const DEFAULT_CODE = `ORG 100h

    mov ax, 0xB800
	mov es, ax         ; ES points to Video RAM
	mov si, hello8086  ; SI points to source data
	mov di, 1990       ; DI points to center of screen (Row 12, Column 35)
	mov cx, 10         ; Loop 10 times (10 characters)

print_loop:
	lodsw              ; Load word from [SI] into AX, SI += 2
	mov [es:di], ax    ; Write directly to VGA screen
	add di, 2          ; Move to next screen cell
	loop print_loop
	hlt

hello8086:
	dw 0x0C48 ; 'H' (Light Red)
	dw 0x0E65 ; 'e' (Yellow)
	dw 0x0A6C ; 'l' (Light Green)
	dw 0x0B6C ; 'l' (Light Cyan)
	dw 0x096F ; 'o' (Light Blue)
	dw 0x0020 ; ' ' (Space)
	dw 0x0D38 ; '8' (Light Magenta)
	dw 0x0C30 ; '0' (Light Red)
	dw 0x0E38 ; '8' (Yellow)
	dw 0x0A36 ; '6' (Light Green)
`;

const toHex = (n, pad = 4) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(pad, '0');
const calcPhys = (s, o) => (((s & 0xFFFF) << 4) + (o & 0xFFFF)) & (ADDR_SPACE - 1);
const calcParity = (val) => {
    let p = 0, v = val & 0xFF;
    while (v) { p ^= (v & 1); v >>= 1; }
    return (p === 0) ? 1 : 0;
};

// ==========================================
// 2. UI SUB-COMPONENTS
// ==========================================

function HeaderControls({ isRunning, initAudio, bootFromDisk, assemble, handleReset, toggleRun, stepUI, loadStateFromJson, saveStateToJson }) {
    return (
        <div className="flex flex-col md:flex-row justify-between items-center bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-2xl">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-800 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <span className="font-bold text-white text-xl">OS</span>
                </div>
                <div>
                    <h1 className="text-xl font-bold text-white tracking-tight">8086 BOOTABLE EMULATOR</h1>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                        1MB RAM MAP | Engine: <span className="ml-1 text-fuchsia-400 font-bold">X86 HARDWARE</span>
                    </p>
                </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-4 md:mt-0 justify-center items-center">
                <label className="px-4 py-2 bg-fuchsia-600 hover:bg-fuchsia-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95 cursor-pointer flex items-center">
                    <span className="mr-1">📥</span> Load from JSON
                    <input type="file" accept=".json" className="hidden" onChange={loadStateFromJson} disabled={isRunning} />
                </label>
                <button onClick={saveStateToJson} disabled={isRunning} className="px-4 py-2 bg-fuchsia-700 hover:bg-fuchsia-600 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50">💾 Save to JSON</button>
                <button onClick={initAudio} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-bold transition-all active:scale-95">🔊 Audio</button>
                <button onClick={bootFromDisk} disabled={isRunning} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50">🚀 Boot</button>
                <button onClick={assemble} disabled={isRunning} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50">Assemble</button>
                <button onClick={handleReset} className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95">🔄 Reset</button>
                <button onClick={toggleRun} className={`px-4 py-2 text-white rounded-lg text-sm font-bold shadow-lg ${isRunning ? "bg-red-600" : "bg-emerald-600"}`}>
                    {isRunning ? "Stop" : "Run"}
                </button>
                <button onClick={stepUI} disabled={isRunning} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-bold shadow-lg disabled:opacity-50">Step</button>
            </div>
        </div>
    );
}

function CodeEditor({ code, setCode, orgOffset, setOrgOffset }) {
    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col h-[500px] lg:h-[740px]">
            <div className="bg-slate-950/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center z-20 relative">
                <h2 className="text-sm font-bold text-indigo-400 uppercase">Boot Code / Assembler</h2>
                <div className="flex items-center space-x-4 text-[10px]">
                    <div className="flex items-center space-x-2">
                        <span className="text-slate-500">ORG (Origin):</span>
                        <input type="text" value={orgOffset} onChange={ev => setOrgOffset(ev.target.value)} className="w-14 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-amber-400 text-center font-bold focus:outline-none focus:border-amber-500" />
                    </div>
                    <label className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded cursor-pointer transition-all active:scale-95">
                        📂 Load .asm
                        <input type="file" accept=".asm,.s,.txt" className="hidden" onChange={e => {
                            const file = e.target.files[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = ev => setCode(ev.target.result);
                            reader.readAsText(file);
                            e.target.value = null;
                        }} />
                    </label>
                </div>
            </div>
            <div className="relative flex-1 bg-slate-950/30 overflow-hidden">
                <textarea
                    value={code}
                    onChange={(ev) => { setCode(ev.target.value); }}
                    className="absolute inset-0 w-full h-full bg-transparent p-4 font-mono text-[13px] focus:outline-none resize-none leading-[24px] whitespace-pre custom-scrollbar z-10 text-emerald-400"
                    spellCheck="false"
                />
            </div>
        </div>
    );
}

function VGAMonitor({ memory, cs, ip, cursorX, cursorY }) {
    if (!memory) return null; 
    
    return (
        <div className="bg-slate-800 p-2 rounded-xl border-4 border-slate-700 shadow-2xl flex flex-col items-center overflow-x-auto">
            <div className="w-full flex justify-between mb-2 px-2 text-[10px] text-slate-400 font-bold min-w-max">
                <span>VGA {VGA_COLS}x{VGA_ROWS} TEXT MODE</span>
                <div className="flex space-x-2">
                     <span className="text-blue-400">CS: {toHex(cs)}</span>
                     <span className="text-amber-400">IP: {toHex(ip)}</span>
                </div>
            </div>
            <div className="bg-black p-2 rounded border border-slate-900 font-mono text-[11px] leading-none whitespace-pre select-none ring-2 ring-black">
                {Array.from({ length: VGA_ROWS }).map((_, y) => (
                    <div key={y} className="flex h-[1.1em]">
                        {Array.from({ length: VGA_COLS }).map((_, x) => {
                            const offset = (y * VGA_COLS + x) * 2;
                            const charCode = memory[VGA_BASE + offset] || 0;
                            let attr = memory[VGA_BASE + offset + 1];
                            if (attr === 0) attr = 0x07;
                            const fg = DOS_COLORS[attr & 0x0F];
                            const bg = DOS_COLORS[(attr >> 4) & 0x0F];
                            const displayChar = (charCode >= 32 && charCode <= 126) ? String.fromCharCode(charCode) : ' ';
                            const isCursor = (x === cursorX && y === cursorY);
                            
                            return (
                                <span key={x} style={{ color: fg, backgroundColor: bg, width: '1ch', textAlign: 'center', display: 'inline-block', position: 'relative' }}>
                                    {displayChar}
                                    {isCursor && <span className="absolute left-0 bottom-[1px] w-full h-[2px] bg-slate-300 animate-cursor-blink z-10"></span>}
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

function MemoryViewer({ title = "Memory View", getMemByte, memSegStr, setMemSegStr, memOffStr, setMemOffStr, hasToggle = false, isToggled = false, onToggle, onMemoryChange, isRunning, onLoadMemory }) {
    const seg = parseInt(memSegStr.replace(/0x/i, ''), 16) || 0;
    const off = parseInt(memOffStr.replace(/0x/i, ''), 16) || 0;

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const buffer = ev.target.result;
            const u8 = new Uint8Array(buffer);
            let data = u8;
            if (file.name.match(/\.(hex|txt)$/i)) {
                const isText = u8.length > 0 && u8.slice(0, 1024).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126));
                if (isText) {
                    const text = new TextDecoder().decode(u8);
                    const hexMatches = text.match(/[0-9A-Fa-f]{2}/g);
                    if (hexMatches && hexMatches.length > 0) {
                        data = new Uint8Array(hexMatches.map(h => parseInt(h, 16)));
                    }
                }
            }
            if (onLoadMemory) onLoadMemory(calcPhys(seg, off), data, file.name);
        };
        reader.readAsArrayBuffer(file);
        e.target.value = null; 
    };

    const rows = [];
    for (let r = 0; r < 8; r++) { 
        const rowOff = (off + r * 16) & 0xFFFF;
        const rowPhys = calcPhys(seg, rowOff);
        const bytes = [];
        const chars = [];
        
        for (let c = 0; c < 16; c++) {
            const addr = rowPhys + c;
            const val = getMemByte && getMemByte(addr); 
            
            if (val !== null && val !== undefined) {
                bytes.push(
                    <input
                        key={`${addr}-${val}`}
                        type="text"
                        maxLength={2}
                        defaultValue={val.toString(16).padStart(2, '0').toUpperCase()}
                        onBlur={(e) => onMemoryChange && onMemoryChange(addr, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                        onFocus={(e) => e.target.select()}
                        disabled={isRunning}
                        className={`w-[2ch] p-0 m-0 border-none bg-transparent text-center outline-none focus:bg-slate-700 focus:text-white rounded-sm cursor-text disabled:cursor-default ${val !== 0 ? "text-amber-400" : "text-slate-600"}`}
                    />
                );
                chars.push((val >= 32 && val <= 126) ? String.fromCharCode(val) : '.');
            } else {
                bytes.push(<span key={c} className="text-red-900/50 w-[2ch] inline-block text-center select-none font-bold">--</span>);
                chars.push('.');
            }
        }
        
        rows.push(
            <div key={r} className="flex space-x-3 items-center whitespace-nowrap">
                <span className="text-blue-400 w-[14ch] shrink-0 select-none">{toHex(seg)}:{toHex(rowOff)}</span>
                <span className="flex-1 flex justify-between tracking-widest">{bytes}</span>
                <span className="text-emerald-500 w-[16ch] shrink-0 text-right whitespace-pre">{chars.join('')}</span>
            </div>
        );
    }

    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-xl h-[230px]">
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                <div className="flex items-center space-x-3">
                    <h2 className="text-[10px] font-bold text-fuchsia-400 uppercase tracking-widest font-mono">{title}</h2>
                    {hasToggle && (
                        <label className="flex items-center space-x-1 text-[9px] text-slate-400 cursor-pointer hover:text-slate-200">
                            <input type="checkbox" checked={isToggled} onChange={e => onToggle(e.target.checked)} className="cursor-pointer" />
                            <span>View 2</span>
                        </label>
                    )}
                </div>
                <div className="flex space-x-3 text-[10px] items-center">
                    <div className="flex items-center space-x-1">
                        <span className="text-slate-500">SEG:</span>
                        <input type="text" value={memSegStr} onChange={e => setMemSegStr(e.target.value)} className="w-12 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-blue-400 text-center font-bold focus:outline-none focus:border-blue-500" />
                    </div>
                    <div className="flex items-center space-x-1">
                        <span className="text-slate-500">OFF:</span>
                        <input type="text" value={memOffStr} onChange={e => setMemOffStr(e.target.value)} className="w-12 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-amber-400 text-center font-bold focus:outline-none focus:border-amber-500" />
                    </div>
                    <label className={`flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 text-white rounded px-2 py-0.5 cursor-pointer transition-colors ml-1 shadow-lg ${isRunning ? 'opacity-50 pointer-events-none' : ''}`}>
                        <span className="mr-1 text-[11px]">📥</span> Bin Load
                        <input type="file" className="hidden" accept=".bin,.hex,.com,.exe,.txt" onChange={handleFileUpload} disabled={isRunning} />
                    </label>
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
                {packFlags(e).toString(2).padStart(16, '0').replace(/(.{4})/g, '$1 ').trim()}
            </div>
            
            <div className="mt-4 pt-4 border-t border-slate-800">
                <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">BIOS Status</div>
                <div className="text-[10px] space-y-1">
                    <div className="flex justify-between"><span>Boot Sig:</span> <span className={hasBootSig ? "text-emerald-500" : "text-red-500"}>{hasBootSig ? "0xAA55" : "MISSING"}</span></div>
                    <div className="flex justify-between"><span>Audio:</span> <span className={e.beeping ? "text-amber-400" : "text-slate-600"}>{e.beeping ? "ON" : "OFF"}</span></div>
                </div>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-800 text-[10px] font-mono">
                <span className="text-slate-400 font-bold">System Logs:</span>
                <div className="h-24 overflow-hidden mt-1 text-emerald-400/70 custom-scrollbar">
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

    const [orgOffset, setOrgOffset] = useState("0x0000"); 
    const [memSegStr, setMemSegStr] = useState("0x0000"); 
    const [memOffStr, setMemOffStr] = useState("0x0000");
    const [showMem2, setShowMem2] = useState(false);
    const [mem2SegStr, setMem2SegStr] = useState("0xB800"); 
    const [mem2OffStr, setMem2OffStr] = useState("0x0000");
    
    const [ioLogs, setIoLogs] = useState([]);
    const [, setTick] = useState(0);
    const forceRender = () => setTick(t => t + 1);

    const isRunningRef = useRef(false);
    const requestRef = useRef(null);
    const audioCtxRef = useRef(null);
    const oscRef = useRef(null);

    const eng = useRef({
        reg: { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, SP: INITIAL_SP, BP: 0, CS: 0, DS: 0, SS: 0, ES: 0, IP: 0 },
        flags: { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 },
        mem: new Uint8Array(ADDR_SPACE), 
        disk: new Uint8Array(DISK_SIZE),
        ioPorts: {},
        diskSectorSelect: 0,
        t2Div: 0,
        t2High: false,
        freq: 0,
        beeping: false,
        cursorX: 0,
        cursorY: 0
    });

    const addLog = (msg) => setIoLogs(prev => [...prev, msg].slice(-20));

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

    const getMemByteSafe = (phys) => {
        if (phys < ADDR_SPACE) return eng.current.mem[phys];
        return null; 
    };

    const handleMemoryChange = (addr, valStr) => {
        let val = parseInt(valStr, 16);
        if (isNaN(val)) val = 0;
        writeMem8Safe(eng.current, addr, val);
        forceRender();
    };

    const handleLoadMemory = (startAddr, data, filename) => {
        const e = eng.current;
        for (let i = 0; i < data.length; i++) {
            writeMem8Safe(e, startAddr + i, data[i]);
        }
        addLog(`Loaded ${data.length} bytes from ${filename} to ${toHex(startAddr, 5)}`);
        forceRender();
    };

    // Load trạng thái JSON (State Parsing) in React JS format
    const loadStateFromJson = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const state = JSON.parse(ev.target.result);
                const en = eng.current;

                setIsRunning(false);
                isRunningRef.current = false;
                if (requestRef.current) cancelAnimationFrame(requestRef.current);

                if (state.registers) {
                    for (const [reg, val] of Object.entries(state.registers)) {
                        const r = reg.toUpperCase();
                        if (en.reg[r] !== undefined) {
                            en.reg[r] = parseInt(val, 16) & 0xFFFF;
                        }
                    }
                }

                if (state.flags) {
                    for (const [flg, val] of Object.entries(state.flags)) {
                        const f = flg.toUpperCase();
                        if (en.flags[f] !== undefined) {
                            en.flags[f] = val ? 1 : 0;
                        }
                    }
                }

                if (state.vga) {
                    if (state.vga.cursorX !== undefined) en.cursorX = Math.min(Math.max(state.vga.cursorX, 0), 79);
                    if (state.vga.cursorY !== undefined) en.cursorY = Math.min(Math.max(state.vga.cursorY, 0), 24);
                }

                if (state.memory && Array.isArray(state.memory)) {
                    for (const block of state.memory) {
                        if (!block.data) continue;
                        const startAddr = parseInt(block.address, 16) || 0;
                        for (let i = 0; i < block.data.length; i++) {
                            const addr = (startAddr + i) & 0xFFFFF;
                            const val = parseInt(block.data[i], 16) & 0xFF;
                            writeMem8Safe(en, addr, val); 
                        }
                    }
                }

                addLog(`✅ Nạp thành công State JSON ${state.description ? `(${state.description})` : ''}`);
                setErrorMessage(null);
                forceRender();
            } catch (err) {
                setErrorMessage(`Lỗi nạp file JSON: ${err.message}`);
            }
        };
        reader.readAsText(file);
        e.target.value = null;
    };

    const saveStateToJson = () => {
        const en = eng.current;

        // Collect non-zero memory blocks (scan in 16-byte chunks)
        const CHUNK = 16;
        const memBlocks = [];
        let blockStart = -1;
        let blockData = [];

        const flushBlock = () => {
            if (blockStart >= 0 && blockData.length > 0) {
                memBlocks.push({
                    address: blockStart.toString(16).toUpperCase().padStart(5, '0'),
                    data: blockData.map(b => b.toString(16).toUpperCase().padStart(2, '0'))
                });
            }
            blockStart = -1;
            blockData = [];
        };

        for (let addr = 0; addr < en.mem.length; addr += CHUNK) {
            const end = Math.min(addr + CHUNK, en.mem.length);
            let hasNonZero = false;
            for (let i = addr; i < end; i++) {
                if (en.mem[i] !== 0) { hasNonZero = true; break; }
            }
            if (hasNonZero) {
                if (blockStart < 0) blockStart = addr;
                for (let i = addr; i < end; i++) blockData.push(en.mem[i]);
            } else {
                flushBlock();
            }
        }
        flushBlock();

        const state = {
            description: `Saved at CS:IP ${toHex(en.reg.CS)}:${toHex(en.reg.IP)} on ${new Date().toISOString()}`,
            registers: Object.fromEntries(
                Object.entries(en.reg).map(([k, v]) => [k, v.toString(16).toUpperCase().padStart(4, '0')])
            ),
            flags: Object.fromEntries(
                Object.entries(en.flags).map(([k, v]) => [k, v ? 1 : 0])
            ),
            vga: { cursorX: en.cursorX, cursorY: en.cursorY },
            memory: memBlocks
        };

        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `8086state_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        addLog(`💾 Đã lưu state JSON (${memBlocks.length} memory blocks)`);
    };

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
        e.reg.SP = INITIAL_SP;
        e.reg.IP = parseInt(orgOffset.replace(/0x/i, ''), 16) || 0;
        e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 };
        e.mem.fill(0);
        e.cursorX = 0;
        e.cursorY = 0;
        setErrorMessage(null);
        forceRender();
    };

    const resetCPU = () => {
        const e = eng.current;
        Object.keys(e.reg).forEach(k => e.reg[k] = 0);
        e.reg.SP = INITIAL_SP;
        e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 };
        if (!keepMemory) e.mem.fill(0);
        e.ioPorts = {};
        e.t2Div = 0;
        e.t2High = false;
        e.freq = 0;
        e.beeping = false;
        e.cursorX = 0;
        e.cursorY = 0;
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
            writeMem8Safe(eng.current, KBD_BUF_ADDR, e.key.charCodeAt(0));
            eng.current.ioPorts[0x60] = e.key.charCodeAt(0);
            forceRender();
        }
    };

    const handleOut = (port, val) => {
        const e = eng.current;
        if (port === 0x70) e.diskSectorSelect = val % 256;
        if (port === 0x71) {
            const rAddr = calcPhys(e.reg.DS, e.reg.BX); const dAddr = e.diskSectorSelect * 16;
            if (val === 1) for(let i=0; i<16; i++) writeMem8Safe(e, rAddr + i, e.disk[dAddr + i]);
            if (val === 2) for(let i=0; i<16; i++) e.disk[dAddr + i] = readMem8(e, rAddr + i);
        }
        if (port === 0x42) {
            if (!e.t2High) { e.t2Div = val; e.t2High = true; }
            else { e.t2Div |= (val << 8); e.t2High = false; if (e.t2Div > 0) e.freq = PC_TIMER_FREQ / e.t2Div; }
        }
        if (port === 0x61) {
            const enable = (val & 0x03) === 0x03;
            if (enable && !e.beeping) { e.beeping = true; playBeep(e.freq); } else if (!enable && e.beeping) { e.beeping = false; stopAudio(); }
        }
        addLog(`OUT 0x${port.toString(16).toUpperCase()}: 0x${val.toString(16).toUpperCase()}`);
    };

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

    // ===============================================
    // ENGINE 2: TRUE HARDWARE X86 DECODER (Lõi Nhị phân)
    // ===============================================
    const executeBinaryStep = () => {
        const e = eng.current;
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
            const isWord = op === 0xE5; const port = fetch8(); const val = e.ioPorts[port] || 0;
            if (isWord) setReg16(0, val); else setReg8(0, val);
            return true;
        }
        if (op === 0xEC || op === 0xED) { 
            const isWord = op === 0xED; const port = e.reg.DX; const val = e.ioPorts[port] || 0;
            if (isWord) setReg16(0, val); else setReg8(0, val);
            return true;
        }
        if (op === 0xE6 || op === 0xE7) { 
            const isWord = op === 0xE7; const port = fetch8(); handleOut(port, e.reg.AX & (isWord ? 0xFFFF : 0xFF));
            return true;
        }
        if (op === 0xEE || op === 0xEF) { 
            const isWord = op === 0xEF; const port = e.reg.DX; handleOut(port, e.reg.AX & (isWord ? 0xFFFF : 0xFF));
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

    const executeStep = () => {
        return executeBinaryStep();
    };

    const stepUI = () => {
        try {
            const e = eng.current;
            const cs = e.reg.CS, ipBefore = e.reg.IP;
            executeStep();
            const ipAfter = e.reg.IP;
            const len = ((ipAfter - ipBefore) & 0xFFFF) || 1;
            const bytes = [];
            for (let i = 0; i < Math.min(len, 8); i++) bytes.push(readMem8(e, calcPhys(cs, (ipBefore + i) & 0xFFFF)));
            addLog(`${toHex(cs)}:${toHex(ipBefore)} | ${bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
            forceRender();
        } catch (ex) { setErrorMessage(ex.message); setIsRunning(false); isRunningRef.current = false; }
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

    const assemble = () => {
        try {
            setErrorMessage(null);
            let startIP = parseInt(orgOffset.replace(/0x/i, ''), 16) || 0;
            const hasOrg = /^\s*\.?org\b/im.test(code);
            const sourceCode = hasOrg ? code : `ORG ${startIP}\n${code}`;
            // Extract the actual ORG value from source so we load at the right address
            if (hasOrg) {
                const orgMatch = code.match(/^\s*\.?org\s+([0-9a-fA-Fx]+h?)\s*$/im);
                if (orgMatch) {
                    let v = orgMatch[1].trim();
                    if (/h$/i.test(v)) startIP = parseInt(v.slice(0, -1), 16);
                    else if (/^0x/i.test(v)) startIP = parseInt(v, 16);
                    else startIP = parseInt(v, 10);
                    if (isNaN(startIP)) startIP = 0;
                }
            }
            const assembler = new Assembler8086();
            const binary = assembler.assemble(sourceCode);
            resetCPU();
            const e = eng.current;
            for (let i = 0; i < binary.length; i++) {
                writeMem8Safe(e, startIP + i, binary[i]);
            }
            e.reg.CS = 0x0000;
            e.reg.IP = startIP;
            addLog(`Assembled: ${binary.length} bytes loaded at ${toHex(startIP, 4)} (CS:IP = 0000:${toHex(startIP, 4)})`);
            forceRender();
        } catch (err) {
            setErrorMessage(`Assemble error: ${err.message}`);
        }
    };

    const bootFromDisk = () => {
        const e = eng.current;
        if (e.disk[SECTOR_SIZE - 2] !== 0x55 || e.disk[SECTOR_SIZE - 1] !== 0xAA) { setErrorMessage("Boot signature 0xAA55 not found!"); return; }
        resetCPU();
        for (let i = 0; i < SECTOR_SIZE; i++) e.mem[BOOT_LOAD_ADDR + i] = e.disk[i];
        e.reg.IP = BOOT_LOAD_ADDR; e.reg.CS = 0x0000;
        addLog(`BIOS: Booting from disk at ${toHex(BOOT_LOAD_ADDR, 4)}...`);
        setIsRunning(true); isRunningRef.current = true;
        requestRef.current = requestAnimationFrame(runLoop);
    };

    useEffect(() => {
        return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); stopAudio(); };
    }, []);

    const e = eng.current;
    const hasBootSig = e.disk[SECTOR_SIZE - 2] === 0x55 && e.disk[SECTOR_SIZE - 1] === 0xAA;

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 p-4 font-mono selection:bg-blue-500/30" onKeyDown={handleKeyDown} tabIndex="0">
            <div className="max-w-[1400px] mx-auto space-y-6 outline-none">
                
                <HeaderControls
                    isRunning={isRunning} initAudio={initAudio}
                    bootFromDisk={bootFromDisk} assemble={assemble} handleReset={handleReset}
                    toggleRun={toggleRun} stepUI={stepUI} loadStateFromJson={loadStateFromJson} saveStateToJson={saveStateToJson}
                />

                {errorMessage && (
                    <div className="bg-red-950/50 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg shadow-lg flex">
                        <p className="font-bold mr-2">SYSTEM HALT:</p> {errorMessage}
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    <div className="lg:col-span-4 space-y-4 flex flex-col">
                        <CodeEditor code={code} setCode={setCode} orgOffset={orgOffset} setOrgOffset={setOrgOffset} />
                    </div>

                    <div className="lg:col-span-6 space-y-4">
                        <VGAMonitor memory={e.mem} cs={e.reg.CS} ip={e.reg.IP} cursorX={e.cursorX} cursorY={e.cursorY} />
                        <MemoryViewer 
                            title="Memory View 1" 
                            getMemByte={getMemByteSafe} 
                            memSegStr={memSegStr} setMemSegStr={setMemSegStr} 
                            memOffStr={memOffStr} setMemOffStr={setMemOffStr} 
                            hasToggle={true} isToggled={showMem2} onToggle={setShowMem2}
                            onMemoryChange={handleMemoryChange} isRunning={isRunning}
                            onLoadMemory={handleLoadMemory}
                        />
                        {showMem2 && (
                            <MemoryViewer 
                                title="Memory View 2" 
                                getMemByte={getMemByteSafe} 
                                memSegStr={mem2SegStr} setMemSegStr={setMem2SegStr} 
                                memOffStr={mem2OffStr} setMemOffStr={setMem2OffStr} 
                                onMemoryChange={handleMemoryChange} isRunning={isRunning}
                                onLoadMemory={handleLoadMemory}
                            />
                        )}
                        <DiskViewer diskMemory={e.disk} />
                    </div>

                    <div className="lg:col-span-2 space-y-4">
                        <RegistersPanel eng={eng} isRunning={isRunning} handleRegChange={handleRegChange} packFlags={packFlags} hasBootSig={hasBootSig} ioLogs={ioLogs} />
                    </div>
                </div>
            </div>
            <style>{`
                @keyframes cursor-blink {
                    0%, 49% { opacity: 1; }
                    50%, 100% { opacity: 0; }
                }
                .animate-cursor-blink { animation: cursor-blink 1s step-end infinite; }
                .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            `}</style>
        </div>
    );
}