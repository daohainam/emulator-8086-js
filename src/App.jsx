import React, { useState, useEffect, useRef, useCallback } from 'react';

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

const DEFAULT_CODE = `; --- DEMO: MULTICOLOR HELLO 8086 ---
MOV AX, 0x0000
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
const calcPhys = (s, o) => (((s & 0xFFFF) << 4) + (o & 0xFFFF)) & (ADDR_SPACE - 1);
const calcParity = (val) => {
    let p = 0, v = val & 0xFF;
    while (v) { p ^= (v & 1); v >>= 1; }
    return (p === 0) ? 1 : 0;
};

// ==========================================
// 2. UI SUB-COMPONENTS
// ==========================================

function HeaderControls({ isRunning, isAssembled, initAudio, bootFromDisk, assemble, handleReset, toggleRun, stepUI, execMode }) {
    return (
        <div className="flex flex-col md:flex-row justify-between items-center bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-2xl">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-800 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <span className="font-bold text-white text-xl">OS</span>
                </div>
                <div>
                    <h1 className="text-xl font-bold text-white tracking-tight">8086 BOOTABLE EMULATOR</h1>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                        1MB RAM | Engine: 
                        <span className={`ml-1 ${execMode === 'BIN' ? 'text-fuchsia-400 font-bold' : 'text-indigo-400 font-bold'}`}>
                            {execMode === 'BIN' ? 'X86 HARDWARE' : 'AST INTERPRETER'}
                        </span>
                    </p>
                </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-4 md:mt-0 justify-center">
                <button onClick={initAudio} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-bold transition-all active:scale-95">🔊 Audio</button>
                <button onClick={bootFromDisk} disabled={isRunning} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50">🚀 Boot</button>
                <button onClick={assemble} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold shadow-lg">Assemble</button>
                <button onClick={handleReset} className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all active:scale-95">🔄 Reset</button>
                <button onClick={toggleRun} disabled={!isAssembled && execMode === 'AST'} className={`px-4 py-2 text-white rounded-lg text-sm font-bold shadow-lg ${(!isAssembled && execMode === 'AST') ? "bg-slate-800 opacity-50" : isRunning ? "bg-red-600" : "bg-emerald-600"}`}>
                    {isRunning ? "Stop" : "Run"}
                </button>
                <button onClick={stepUI} disabled={isRunning || (!isAssembled && execMode === 'AST')} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-bold shadow-lg disabled:opacity-50">Step</button>
            </div>
        </div>
    );
}

function CodeEditor({ code, setCode, setIsAssembled, orgOffset, setOrgOffset, keepMemory, setKeepMemory, activeLine, execMode }) {
    const overlayRef = useRef(null);
    const textareaRef = useRef(null);

    const handleScroll = (e) => {
        if (overlayRef.current) {
            overlayRef.current.scrollTop = e.target.scrollTop;
            overlayRef.current.scrollLeft = e.target.scrollLeft;
        }
    };

    useEffect(() => {
        if (activeLine >= 0 && textareaRef.current && overlayRef.current) {
            const textarea = textareaRef.current;
            const lineHeight = 24; 
            const targetY = activeLine * lineHeight;
            const containerHeight = textarea.clientHeight;
            const currentScroll = textarea.scrollTop;
            if (targetY < currentScroll || targetY > currentScroll + containerHeight - lineHeight * 2) {
                textarea.scrollTop = targetY - containerHeight / 2 + lineHeight;
            }
        }
    }, [activeLine]);

    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col h-[500px] lg:h-[740px]">
            <div className="bg-slate-950/50 px-4 py-3 border-b border-slate-800 flex justify-between items-center z-20 relative">
                <h2 className="text-sm font-bold text-indigo-400 uppercase">Boot Code / Assembler</h2>
                <div className="flex items-center space-x-4 text-[10px]">
                    <label className="flex items-center space-x-1 text-slate-400 cursor-pointer hover:text-slate-200">
                        <input type="checkbox" checked={keepMemory} onChange={e => setKeepMemory(e.target.checked)} className="cursor-pointer" />
                        <span>Keep RAM</span>
                    </label>
                    <div className="flex items-center space-x-2">
                        <span className="text-slate-500">ORG (Origin):</span>
                        <input type="text" value={orgOffset} onChange={ev => setOrgOffset(ev.target.value)} className="w-14 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-amber-400 text-center font-bold focus:outline-none focus:border-amber-500" />
                    </div>
                </div>
            </div>
            <div className="relative flex-1 bg-slate-950/30 overflow-hidden">
                <div ref={overlayRef} className="absolute inset-0 p-4 font-mono text-[13px] leading-[24px] whitespace-pre overflow-hidden pointer-events-none z-0">
                    {code.split('\n').map((line, i) => (
                        <div key={i} className={`h-[24px] w-fit min-w-full rounded-sm ${i === activeLine ? "bg-amber-500/30 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.4)]" : ""}`}>
                            <span className="text-transparent">{line.replace(/\r/g, '') || '\u00A0'}</span>
                        </div>
                    ))}
                </div>
                <textarea 
                    ref={textareaRef}
                    value={code} 
                    onChange={(ev) => { setCode(ev.target.value); setIsAssembled(false); }} 
                    onScroll={handleScroll}
                    disabled={execMode === 'BIN'}
                    className={`absolute inset-0 w-full h-full bg-transparent p-4 font-mono text-[13px] focus:outline-none resize-none leading-[24px] whitespace-pre custom-scrollbar z-10 ${execMode === 'BIN' ? 'text-slate-500 cursor-not-allowed' : 'text-emerald-400'}`} 
                    spellCheck="false" 
                />
                
                {execMode === 'BIN' && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/40 backdrop-blur-[2px] pointer-events-none transition-all duration-300">
                        <div className="bg-slate-900/90 border border-fuchsia-500/30 text-fuchsia-400 px-5 py-4 rounded-xl shadow-2xl flex items-center space-x-3">
                            <span className="text-2xl">🔒</span>
                            <div className="flex flex-col">
                                <span className="font-bold text-xs uppercase tracking-widest mb-1">Mã Assembly bị khóa</span>
                                <span className="text-[10px] text-slate-400">Đang mô phỏng mã máy (X86 Hardware)</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function VGAMonitor({ memory, cs, ip }) {
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
                            const attr = memory[VGA_BASE + offset + 1] || 0x07;
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
                        <span className="mr-1 text-[11px]">📥</span> Load
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
    const [keepMemory, setKeepMemory] = useState(false);
    const [execMode, setExecMode] = useState("AST"); 

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
        mem: new Uint8Array(ADDR_SPACE),   // Toàn bộ 1MB RAM không gian địa chỉ
        disk: new Uint8Array(DISK_SIZE),
        ioPorts: {},
        insts: [],
        labels: {},
        diskSectorSelect: 0,
        t2Div: 0,
        t2High: false,
        freq: 0,
        beeping: false
    });

    const addLog = (msg) => setIoLogs(prev => [...prev, msg].slice(-20));

    // ===============================================
    // CORE: MEMORY MANAGER
    // ===============================================
    const readMem8 = (e, phys) => {
        return e.mem[phys];
    };

    const writeMem8 = (e, phys, val) => {
        e.mem[phys] = val & 0xFF;
    };

    const readMemWord = (e, phys) => readMem8(e, phys) | (readMem8(e, phys + 1) << 8);
    const writeMemWord = (e, phys, val) => { writeMem8(e, phys, val & 0xFF); writeMem8(e, phys + 1, (val >> 8) & 0xFF); };
    const push16 = (e, val) => { e.reg.SP = (e.reg.SP - 2) & 0xFFFF; writeMemWord(e, calcPhys(e.reg.SS, e.reg.SP), val); };
    const pop16 = (e) => { const val = readMemWord(e, calcPhys(e.reg.SS, e.reg.SP)); e.reg.SP = (e.reg.SP + 2) & 0xFFFF; return val; };

    const getMemByteSafe = (phys) => {
        if (phys < ADDR_SPACE) return eng.current.mem[phys];
        return null; // Return null for Unmapped Memory
    };

    const handleMemoryChange = (addr, valStr) => {
        let val = parseInt(valStr, 16);
        if (isNaN(val)) val = 0;
        if (addr < ADDR_SPACE) eng.current.mem[addr] = val & 0xFF;
        forceRender();
    };

    const handleLoadMemory = (startAddr, data, filename) => {
        const e = eng.current;
        for (let i = 0; i < data.length; i++) {
            const addr = startAddr + i;
            if (addr < ADDR_SPACE) e.mem[addr] = data[i];
            else break; // Dừng nếu vượt quá giới hạn 1MB
        }
        addLog(`Loaded ${data.length} bytes from ${filename} to ${toHex(startAddr, 5)}`);
        setExecMode("BIN"); 
        forceRender();
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
        if (!keepMemory) e.mem.fill(0); 
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
            writeMem8(eng.current, KBD_BUF_ADDR, e.key.charCodeAt(0));
            eng.current.ioPorts[0x60] = e.key.charCodeAt(0);
            forceRender();
        }
    };

    const handleOut = (port, val) => {
        const e = eng.current;
        if (port === 0x70) e.diskSectorSelect = val % 256;
        if (port === 0x71) {
            const rAddr = calcPhys(e.reg.DS, e.reg.BX); const dAddr = e.diskSectorSelect * 16;
            if (val === 1) for(let i=0; i<16; i++) writeMem8(e, rAddr + i, e.disk[dAddr + i]);
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
    const writeToVGA = (e, c) => {
        for (let i = 0; i < VGA_COLS * VGA_ROWS; i++) {
            if (e.mem[VGA_BASE + i * 2] === 0) { e.mem[VGA_BASE + i * 2] = c.charCodeAt(0); e.mem[VGA_BASE + i * 2 + 1] = 0x07; break; }
        }
    };

    // ===============================================
    // ENGINE 1: AST INTERPRETER (Trình Thông Dịch Chuỗi)
    // ===============================================
    const resolveOffset = (e, s) => {
        s = s.trim().toUpperCase();
        if (s.startsWith("BYTE") || s.startsWith("WORD")) s = s.replace(/^(BYTE|WORD)\s+/, "");
        s = s.replace(/^\[|\]$/g, "").trim();
        if (s.includes(":")) s = s.split(":")[1];
        if (e.reg[s] !== undefined) return e.reg[s];
        if (s.startsWith("0X")) return parseInt(s, 16);
        const parsed = parseInt(s, 10);
        return isNaN(parsed) ? 0 : parsed;
    };
    const getOpVal = (e, op) => {
        op = op.toUpperCase();
        if (e.labels[op] !== undefined) return e.labels[op];
        if (op.includes("[")) {
            let seg = e.reg.DS; if (op.includes("ES:")) seg = e.reg.ES;
            const innerMatch = op.match(/\[(.*)\]/); if (!innerMatch) return 0;
            const phys = calcPhys(seg, resolveOffset(e, innerMatch[1]));
            return op.includes("BYTE") ? readMem8(e, phys) : readMemWord(e, phys);
        }
        if (e.reg[op] !== undefined) return e.reg[op];
        if (op.startsWith("0X")) return parseInt(op, 16);
        const parsed = parseInt(op, 10);
        return isNaN(parsed) ? 0 : parsed;
    };
    const writeOpVal = (e, dst, val) => {
        dst = dst.toUpperCase();
        if (dst.includes("[")) {
            let seg = e.reg.DS; if (dst.includes("ES:")) seg = e.reg.ES;
            const innerMatch = dst.match(/\[(.*)\]/); if (!innerMatch) return;
            const phys = calcPhys(seg, resolveOffset(e, innerMatch[1]));
            if (dst.includes("BYTE")) writeMem8(e, phys, val); else writeMemWord(e, phys, val & 0xFFFF);
        } else if (e.reg[dst] !== undefined) {
            e.reg[dst] = val & 0xFFFF;
        } else throw new Error(`Invalid destination: ${dst}`);
    };

    const executeAstStep = () => {
        const e = eng.current; const r = e.reg; const f = e.flags;
        if (r.IP >= e.insts.length) return false;
        const inst = e.insts[r.IP];
        if (inst && inst.op === "NOP" && inst.originalLine === 0) { r.IP++; return true; }

        let nextIP = r.IP + 1;
        let op = inst.op; let args = inst.args; let prefix = null;

        if (["REP", "REPE", "REPZ", "REPNE", "REPNZ"].includes(op)) {
            if (r.CX === 0) { r.IP = nextIP; return true; }
            prefix = op; op = args.length > 0 ? args[0].toUpperCase() : "NOP"; args = args.slice(1);
        }
        
        const is8Bit = (arg) => arg && (["AL","AH","BL","BH","CL","CH","DL","DH"].includes(arg.toUpperCase()) || arg.toUpperCase().includes("BYTE"));

        switch (op) {
            case "MOV": writeOpVal(e, args[0], getOpVal(e, args[1])); break;
            case "XCHG": { const t = getOpVal(e, args[0]); writeOpVal(e, args[0], getOpVal(e, args[1])); writeOpVal(e, args[1], t); break; }
            case "LEA": { 
                const innerMatch = args[1].match(/\[(.*)\]/); 
                if (innerMatch) writeOpVal(e, args[0], resolveOffset(e, innerMatch[1])); 
                break; 
            }
            case "ADD": case "ADC": case "SUB": case "SBB": case "CMP": case "AND": case "OR": case "XOR": case "TEST": {
                const v1 = getOpVal(e, args[0]); const v2 = getOpVal(e, args[1]);
                const is8 = is8Bit(args[0]); const mask = is8 ? 0xFF : 0xFFFF;
                const signBit = is8 ? 0x80 : 0x8000;
                let res = 0;
                if (op === "ADD") { res = v1 + v2; f.CF = res > mask ? 1 : 0; f.OF = ((v1 ^ res) & (v2 ^ res) & signBit) ? 1 : 0; }
                else if (op === "ADC") { res = v1 + v2 + f.CF; f.CF = res > mask ? 1 : 0; f.OF = ((v1 ^ res) & (v2 ^ res) & signBit) ? 1 : 0; }
                else if (op === "SUB" || op === "CMP") { res = v1 - v2; f.CF = v1 < v2 ? 1 : 0; f.OF = ((v1 ^ v2) & (v1 ^ res) & signBit) ? 1 : 0; }
                else if (op === "SBB") { res = v1 - v2 - f.CF; f.CF = v1 < (v2 + f.CF) ? 1 : 0; f.OF = ((v1 ^ v2) & (v1 ^ res) & signBit) ? 1 : 0; }
                else if (op === "AND" || op === "TEST") { res = v1 & v2; f.CF = 0; f.OF = 0; }
                else if (op === "OR") { res = v1 | v2; f.CF = 0; f.OF = 0; }
                else if (op === "XOR") { res = v1 ^ v2; f.CF = 0; f.OF = 0; }

                if (op !== "CMP" && op !== "TEST") writeOpVal(e, args[0], res);
                f.ZF = (res & mask) === 0 ? 1 : 0; f.SF = (res & signBit) ? 1 : 0; f.PF = calcParity(res);
                break;
            }
            case "INC": case "DEC": { 
                const is8 = is8Bit(args[0]); const mask = is8 ? 0xFF : 0xFFFF;
                const signBit = is8 ? 0x80 : 0x8000;
                const orig = getOpVal(e, args[0]);
                const v = op === "INC" ? orig + 1 : orig - 1; 
                writeOpVal(e, args[0], v); 
                f.ZF = (v & mask) === 0 ? 1 : 0; f.SF = (v & signBit) ? 1 : 0; f.PF = calcParity(v);
                if (op === "INC") f.OF = orig === (is8 ? 0x7F : 0x7FFF) ? 1 : 0;
                else f.OF = orig === (is8 ? 0x80 : 0x8000) ? 1 : 0;
                break; 
            }
            case "NOT": {
                const is8 = is8Bit(args[0]); const mask = is8 ? 0xFF : 0xFFFF;
                writeOpVal(e, args[0], (~getOpVal(e, args[0])) & mask); 
                break;
            }
            case "NEG": {
                const is8 = is8Bit(args[0]); const mask = is8 ? 0xFF : 0xFFFF;
                const v = getOpVal(e, args[0]); const res = (0 - v) & mask;
                writeOpVal(e, args[0], res);
                f.CF = v === 0 ? 0 : 1; f.ZF = res === 0 ? 1 : 0; f.SF = (res & (is8 ? 0x80 : 0x8000)) ? 1 : 0; f.PF = calcParity(res);
                break;
            }
            case "MUL": case "IMUL": case "DIV": case "IDIV": {
                const is8 = is8Bit(args[0]); const v = getOpVal(e, args[0]);
                if (op === "MUL") {
                    if (!is8) { const ur = (r.AX * v) >>> 0; r.AX = ur & 0xFFFF; r.DX = (ur >>> 16) & 0xFFFF; f.CF = f.OF = r.DX !== 0 ? 1 : 0; }
                    else { const ur = (r.AX & 0xFF) * v; r.AX = ur & 0xFFFF; f.CF = f.OF = (ur & 0xFF00) !== 0 ? 1 : 0; }
                } else if (op === "IMUL") {
                    if (!is8) { const sr = ((r.AX<<16)>>16) * ((v<<16)>>16); r.AX = sr & 0xFFFF; r.DX = (sr>>16) & 0xFFFF; f.CF = f.OF = ((r.AX&0x8000)?r.DX===0xFFFF:r.DX===0)?0:1; }
                    else { const sr = (((r.AX&0xFF)<<24)>>24) * ((v<<24)>>24); r.AX = sr & 0xFFFF; f.CF=f.OF=((sr&0x80)?(sr&0xFF00)===0xFF00:(sr&0xFF00)===0)?0:1; }
                } else if (op === "DIV") {
                    if (v === 0) throw new Error("Divide by zero");
                    if (!is8) { const dvnd = (r.DX * 0x10000) + r.AX; const q = Math.floor(dvnd/v); if(q>0xFFFF) throw new Error("Overflow"); r.AX = q&0xFFFF; r.DX = dvnd%v; }
                    else { const dvnd = r.AX; const q = Math.floor(dvnd/v); if(q>0xFF) throw new Error("Overflow"); r.AX = ((dvnd%v)<<8) | (q&0xFF); }
                } else if (op === "IDIV") {
                    if (v === 0) throw new Error("Divide by zero");
                    if (!is8) { const dvnd = (r.DX<<16)|r.AX; const ds = (v<<16)>>16; const q = Math.trunc(dvnd/ds); if(q>32767||q<-32768) throw new Error("Overflow"); r.AX=q&0xFFFF; r.DX=dvnd%ds; }
                    else { const dvnd = (r.AX<<16)>>16; const ds = (v<<24)>>24; const q = Math.trunc(dvnd/ds); if(q>127||q<-128) throw new Error("Overflow"); r.AX=(((dvnd%ds)&0xFF)<<8)|(q&0xFF); }
                }
                break;
            }
            case "SHL": case "SAL": case "SHR": case "SAR": case "ROL": case "ROR": case "RCL": case "RCR": {
                const is8 = is8Bit(args[0]); const maxVal = is8 ? 0xFF : 0xFFFF; const msbMask = is8 ? 0x80 : 0x8000; const shiftAmt = is8 ? 7 : 15;
                let count = 1; if(args.length > 1) count = args[1].toUpperCase()==="CL" ? (r.CX&0xFF) : getOpVal(e, args[1]);
                count &= 0x1F;
                if(count > 0) {
                    let val = getOpVal(e, args[0]);
                    for(let i=0; i<count; i++) {
                        const msb = (val & msbMask) !== 0; const lsb = (val & 1) !== 0;
                        if(op==="SHL"||op==="SAL") { f.CF = msb?1:0; val = (val<<1)&maxVal; }
                        else if(op==="SHR") { f.CF = lsb?1:0; val = (val>>1)&maxVal; }
                        else if(op==="SAR") { f.CF = lsb?1:0; val = (val&msbMask) | ((val>>1)&(maxVal>>1)); }
                        else if(op==="ROL") { f.CF = msb?1:0; val = ((val<<1)|f.CF)&maxVal; }
                        else if(op==="ROR") { f.CF = lsb?1:0; val = ((val>>1)|(f.CF<<shiftAmt))&maxVal; }
                        else if(op==="RCL") { const oCF=f.CF; f.CF=msb?1:0; val=((val<<1)|oCF)&maxVal; }
                        else if(op==="RCR") { const oCF=f.CF; f.CF=lsb?1:0; val=((val>>1)|(oCF<<shiftAmt))&maxVal; }
                    }
                    writeOpVal(e, args[0], val);
                    f.ZF = val===0?1:0; f.SF = (val&msbMask)?1:0; f.PF = calcParity(val);
                }
                break;
            }
            case "CBW": r.AX = (r.AX & 0x80) ? (0xFF00 | (r.AX & 0xFF)) : (r.AX & 0xFF); break;
            case "CWD": r.DX = (r.AX & 0x8000) ? 0xFFFF : 0x0000; break;
            case "PUSHA": { const sp = r.SP; push16(e, r.AX); push16(e, r.CX); push16(e, r.DX); push16(e, r.BX); push16(e, sp); push16(e, r.BP); push16(e, r.SI); push16(e, r.DI); break; }
            case "POPA": { r.DI = pop16(e); r.SI = pop16(e); r.BP = pop16(e); pop16(e); r.BX = pop16(e); r.DX = pop16(e); r.CX = pop16(e); r.AX = pop16(e); break; }
            case "LEAVE": { r.SP = r.BP; r.BP = pop16(e); break; }
            case "PUSHF": push16(e, packFlags(e)); break;
            case "POPF": unpackFlags(e, pop16(e)); break;
            case "CLI": f.IF = 0; break; case "STI": f.IF = 1; break;
            case "CLC": f.CF = 0; break; case "STC": f.CF = 1; break; case "CMC": f.CF = 1 - f.CF; break;
            case "CLD": f.DF = 0; break; case "STD": f.DF = 1; break;

            case "OUT": handleOut(getOpVal(e, args[0]), getOpVal(e, args[1])); break;
            case "IN": writeOpVal(e, args[0], e.ioPorts[getOpVal(e, args[1])] || 0); break;
            
            case "JMP": nextIP = e.labels[args[0].toUpperCase()]; break;
            case "CALL": push16(e, nextIP); nextIP = e.labels[args[0].toUpperCase()]; break;
            case "RET": nextIP = pop16(e); if(args.length>0) r.SP = (r.SP + getOpVal(e, args[0])) & 0xFFFF; break;
            case "RETF": nextIP = pop16(e); r.CS = pop16(e); if(args.length>0) r.SP = (r.SP + getOpVal(e, args[0])) & 0xFFFF; break;
            case "IRET": nextIP = pop16(e); r.CS = pop16(e); unpackFlags(e, pop16(e)); break;
            
            case "PUSH": push16(e, getOpVal(e, args[0])); break;
            case "POP": writeOpVal(e, args[0], pop16(e)); break;
            
            case "LOOP": r.CX = (r.CX - 1) & 0xFFFF; if (r.CX !== 0) nextIP = e.labels[args[0].toUpperCase()]; break;
            case "LOOPE": case "LOOPZ": r.CX=(r.CX-1)&0xFFFF; if(r.CX!==0 && f.ZF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "LOOPNE": case "LOOPNZ": r.CX=(r.CX-1)&0xFFFF; if(r.CX!==0 && f.ZF===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JCXZ": if(r.CX===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            
            // Conditional Jumps
            case "JE": case "JZ": if(f.ZF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JNE": case "JNZ": if(f.ZF===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JA": case "JNBE": if(f.CF===0 && f.ZF===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JAE": case "JNB": case "JNC": if(f.CF===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JB": case "JNAE": case "JC": if(f.CF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JBE": case "JNA": if(f.CF===1 || f.ZF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JG": case "JNLE": if(f.ZF===0 && f.SF===f.OF) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JGE": case "JNL": if(f.SF===f.OF) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JL": case "JNGE": if(f.SF!==f.OF) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JLE": case "JNG": if(f.ZF===1 || f.SF!==f.OF) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JO": if(f.OF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JNO": if(f.OF===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JP": case "JPE": if(f.PF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JNP": case "JPO": if(f.PF===0) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JS": if(f.SF===1) nextIP=e.labels[args[0].toUpperCase()]; break;
            case "JNS": if(f.SF===0) nextIP=e.labels[args[0].toUpperCase()]; break;

            case "MOVSB": case "MOVSW": case "MOVS":
            case "LODSB": case "LODSW": case "LODS":
            case "STOSB": case "STOSW": case "STOS":
            case "CMPSB": case "CMPSW": case "CMPS":
            case "SCASB": case "SCASW": case "SCAS": {
                const isWord = op.endsWith("W") || args.includes("WORD");
                const sz = isWord ? 2 : 1; const dir = f.DF === 0 ? sz : -sz;
                if (op.startsWith("MOVS")) {
                    const s = calcPhys(r.DS, r.SI); const d = calcPhys(r.ES, r.DI);
                    if (isWord) writeMemWord(e, d, readMemWord(e, s)); else writeMem8(e, d, readMem8(e, s));
                    r.SI = (r.SI + dir) & 0xFFFF; r.DI = (r.DI + dir) & 0xFFFF;
                } else if (op.startsWith("LODS")) {
                    const s = calcPhys(r.DS, r.SI);
                    if (isWord) r.AX = readMemWord(e, s); else r.AX = (r.AX & 0xFF00) | readMem8(e, s);
                    r.SI = (r.SI + dir) & 0xFFFF;
                } else if (op.startsWith("STOS")) {
                    const d = calcPhys(r.ES, r.DI);
                    if (isWord) writeMemWord(e, d, r.AX); else writeMem8(e, d, r.AX & 0xFF);
                    r.DI = (r.DI + dir) & 0xFFFF;
                } else if (op.startsWith("CMPS")) {
                    const s = calcPhys(r.DS, r.SI); const d = calcPhys(r.ES, r.DI);
                    const v1 = isWord ? readMemWord(e, s) : readMem8(e, s); const v2 = isWord ? readMemWord(e, d) : readMem8(e, d);
                    const res = v1 - v2;
                    f.ZF = (res & (isWord?0xFFFF:0xFF)) === 0 ? 1 : 0; f.CF = v1 < v2 ? 1 : 0; f.PF = calcParity(res);
                    r.SI = (r.SI + dir) & 0xFFFF; r.DI = (r.DI + dir) & 0xFFFF;
                } else if (op.startsWith("SCAS")) {
                    const d = calcPhys(r.ES, r.DI);
                    const v1 = isWord ? r.AX : r.AX & 0xFF; const v2 = isWord ? readMemWord(e, d) : readMem8(e, d);
                    const res = v1 - v2;
                    f.ZF = (res & (isWord?0xFFFF:0xFF)) === 0 ? 1 : 0; f.CF = v1 < v2 ? 1 : 0; f.PF = calcParity(res);
                    r.DI = (r.DI + dir) & 0xFFFF;
                }
                break;
            }

            case "INT": {
                const vec = getOpVal(e, args[0]);
                if (vec === 0x10 && ((r.AX >> 8) & 0xFF) === 0x0E) writeToVGA(e, String.fromCharCode(r.AX & 0xFF));
                break;
            }
            case "HLT": return false;
            case "NOP": break;
            default: throw new Error(`AST INTERPRETER ERROR: Unsupported Opcode ${op}`);
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
                const v = rmRd(m, isWord);
                const res = (0 - v) & (isWord ? 0xFFFF : 0xFF);
                rmWr(m, isWord, res); updFlags(res, isWord);
                e.flags.CF = v === 0 ? 0 : 1; e.flags.PF = calcParity(res);
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
        if (op === 0xE2) { const off = fetch8()<<24>>24; e.reg.CX=(e.reg.CX-1)&0xFFFF; if (e.reg.CX!==0) e.reg.IP=(e.reg.IP+off)&0xFFFF; return true; } 
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
            if (iNum === 0x10 && ((e.reg.AX>>8)&0xFF) === 0x0E) writeToVGA(e, String.fromCharCode(e.reg.AX & 0xFF));
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
        if (execMode === "BIN") return executeBinaryStep();
        else return executeAstStep();
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
    }, [execMode]);

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
        setExecMode("AST"); // Bật lại Mode Interpreter
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

    const bootFromDisk = () => {
        const e = eng.current;
        if (e.disk[SECTOR_SIZE - 2] !== 0x55 || e.disk[SECTOR_SIZE - 1] !== 0xAA) { setErrorMessage("Boot signature 0xAA55 not found!"); return; }
        resetCPU();
        for (let i = 0; i < SECTOR_SIZE; i++) e.mem[BOOT_LOAD_ADDR + i] = e.disk[i];
        e.reg.IP = BOOT_LOAD_ADDR; e.reg.CS = 0x0000;
        setExecMode("BIN"); // Khởi động từ Disk là chạy mã nhị phân thực thụ
        addLog(`BIOS: Booting from disk (Hardware Mode) at ${toHex(BOOT_LOAD_ADDR, 4)}...`);
        setIsAssembled(true); setIsRunning(true); isRunningRef.current = true;
        requestRef.current = requestAnimationFrame(runLoop);
    };

    useEffect(() => {
        return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); stopAudio(); };
    }, []);

    const e = eng.current;
    const hasBootSig = e.disk[SECTOR_SIZE - 2] === 0x55 && e.disk[SECTOR_SIZE - 1] === 0xAA;
    
    let activeLine = -1;
    if (execMode === "AST" && isAssembled && e.reg.IP < e.insts.length) {
        const inst = e.insts[e.reg.IP];
        if (inst && inst.originalLine > 0) activeLine = inst.originalLine - 1; 
    }

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 p-4 font-mono selection:bg-blue-500/30" onKeyDown={handleKeyDown} tabIndex="0">
            <div className="max-w-[1400px] mx-auto space-y-6 outline-none">
                
                <HeaderControls 
                    isRunning={isRunning} isAssembled={isAssembled} initAudio={initAudio} 
                    bootFromDisk={bootFromDisk} assemble={assemble} handleReset={handleReset} 
                    toggleRun={toggleRun} stepUI={stepUI} execMode={execMode}
                />

                {errorMessage && (
                    <div className="bg-red-950/50 border border-red-500/50 text-red-200 px-4 py-3 rounded-lg shadow-lg flex">
                        <p className="font-bold mr-2">SYSTEM HALT:</p> {errorMessage}
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    <div className="lg:col-span-4 space-y-4 flex flex-col">
                        <CodeEditor code={code} setCode={setCode} setIsAssembled={setIsAssembled} orgOffset={orgOffset} setOrgOffset={setOrgOffset} keepMemory={keepMemory} setKeepMemory={setKeepMemory} activeLine={activeLine} execMode={execMode} />
                    </div>

                    <div className="lg:col-span-6 space-y-4">
                        <VGAMonitor memory={e.mem} cs={e.reg.CS} ip={e.reg.IP} />
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
                .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
            `}</style>
        </div>
    );
}