import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Assembler8086 } from './Assembler8086.js';
import { IOBus } from './devices/IOBus.js';
import { NullDevice } from './devices/NullDevice.js';
import { SpeakerDevice } from './devices/SpeakerDevice.js';
import { DiskDevice } from './devices/DiskDevice.js';
import { KeyboardDevice } from './devices/KeyboardDevice.js';
import { PIC8259Device } from './devices/PIC8259Device.js';
import {
    ADDR_SPACE, DISK_SIZE, SECTOR_SIZE, FLOPPY_SIZE,
    VGA_BASE, VGA_COLS, VGA_ROWS, VGA_SIZE,
    toHex, calcPhys, calcParity,
    readMem8, writeMem8, writeMem8Safe,
    readMemWord, writeMemWord,
    push16, pop16,
    packFlags, unpackFlags,
    executeStep,
} from './CPU8086.js';

// ==========================================
// 1. CONSTANTS & UTILITIES
// ==========================================
const DOS_COLORS = [
    "#000000", "#0000AA", "#00AA00", "#00AAAA", "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
    "#555555", "#5555FF", "#55FF55", "#55FFFF", "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF"
];

const BOOT_LOAD_ADDR    = 0x7C00;   // BIOS boot sector load address
const INITIAL_SP        = 0xFFFE;   // Initial stack pointer value
const RESET_VECTOR_PHYS = 0xFFFF0;  // Physical address of x86 reset vector (0xFFFF:0x0000)
const BIOS_ENTRY_SEG    = 0xC000;   // BIOS ROM segment
const BIOS_ENTRY_OFF    = 0x0003;   // BIOS ROM entry point offset

// BDA keyboard buffer — all values are physical addresses or BDA-relative offsets
const BDA_SEG_PHYS         = 0x0400;  // Physical base of BDA segment (0x0040 << 4)
const BDA_KBD_STATUS1_PHYS = 0x0417;  // Physical: keyboard status byte 1
const BDA_KBD_HEAD_PHYS    = 0x041A;  // Physical: buffer head pointer
const BDA_KBD_TAIL_PHYS    = 0x041C;  // Physical: buffer tail pointer
const BDA_KBD_BUF_OFF      = 0x1E;   // BDA-relative offset: start of buffer
const BDA_KBD_BUF_END_OFF  = 0x3E;   // BDA-relative offset: one past end

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
                    <h1 className="text-xl font-bold text-white tracking-tight">8086 EMULATOR</h1>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                        1MB RAM MAP | Engine: <span className="ml-1 text-fuchsia-400 font-bold">X86 HARDWARE</span>
                    </p>
                </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-4 md:mt-0 justify-center items-center">
                <a
                    href="https://github.com/daohainam/emulator-8086-js"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group px-4 py-2 rounded-lg text-sm font-bold border border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:border-amber-300/70 transition-all shadow-lg"
                    title="Star this project on GitHub"
                    aria-label="Star emulator-8086-js on GitHub"
                >
                    <span className="inline-flex items-center gap-1">
                        <span aria-hidden="true">☆</span>
                        Star on GitHub
                    </span>
                </a>
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
    const [maximized, setMaximized] = React.useState(false);
    const inner = (
        <div className={maximized ? "fixed inset-0 z-50 flex flex-col bg-slate-900" : "bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col h-[500px] lg:h-[740px]"}>
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
                    <button onClick={() => setMaximized(m => !m)} className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-all active:scale-95" title={maximized ? 'Restore' : 'Maximize'}>
                        {maximized ? '⛶' : '⛶'}{maximized ? ' ↙' : ' ↗'}
                    </button>
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
    return inner;
}

function VGAMonitor({ memory, cs, ip, cursorX, cursorY, onKeyDown, onKeyUp }) {
    if (!memory) return null;
    const [focused, setFocused] = React.useState(false);

    return (
        <div
            className={`bg-slate-800 p-2 rounded-xl border-4 shadow-2xl flex flex-col items-center overflow-x-auto outline-none transition-colors ${focused ? 'border-green-500' : 'border-slate-700'}`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            title="VGA Screen — click here and type to send keyboard input"
        >
            <div className="w-full flex justify-between mb-2 px-2 text-[10px] text-slate-400 font-bold min-w-max">
                <span>VGA {VGA_COLS}x{VGA_ROWS} TEXT MODE{focused ? <span className="ml-2 text-green-400">⌨ KEYBOARD ACTIVE</span> : ''}</span>
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

function KeyboardPanel({ keyboardDevice, handleKeyDown, handleKeyUp, forceRender }) {
    const inputRef = React.useRef(null);
    const buffer = keyboardDevice ? keyboardDevice.buffer : [];

    const handleClear = () => {
        if (keyboardDevice) keyboardDevice.buffer = [];
        forceRender();
    };

    // Intercept keydown on the text input and route through the shared handler,
    // then reset value so it stays empty (characters go into the device buffer, not the input).
    const onInputKeyDown = (e) => {
        // Prevent browser default for Tab so it routes as a key, not focus-change
        if (e.key === 'Tab') e.preventDefault();
        handleKeyDown(e);
        // Clear the native input value after the key is processed
        requestAnimationFrame(() => { if (inputRef.current) inputRef.current.value = ''; });
    };

    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                <h2 className="text-[10px] font-bold text-cyan-500 uppercase tracking-widest font-mono">⌨ Keyboard Buffer</h2>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 font-mono">{buffer.length}/16 entries</span>
                    <button
                        onClick={handleClear}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-red-700 text-slate-200 rounded transition-colors font-bold"
                    >Clear</button>
                </div>
            </div>

            {/* Text input — type here to send keys to the emulator */}
            <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
                <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">Type here:</span>
                <input
                    ref={inputRef}
                    type="text"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[12px] text-emerald-300 font-mono focus:outline-none focus:border-cyan-500 placeholder-slate-600"
                    placeholder="click and type…"
                    onKeyDown={onInputKeyDown}
                    onKeyUp={handleKeyUp}
                    onChange={() => {}}  /* controlled — value reset via rAF */
                    autoComplete="off" autoCorrect="off" spellCheck={false}
                />
            </div>

            {/* Buffer contents table */}
            <div className="overflow-y-auto max-h-36 font-mono text-[10px]">
                {buffer.length === 0 ? (
                    <div className="px-4 py-3 text-slate-600 italic">(empty)</div>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="text-slate-500 border-b border-slate-800">
                                <th className="px-3 py-1 text-left font-bold">#</th>
                                <th className="px-3 py-1 text-left font-bold">Char</th>
                                <th className="px-3 py-1 text-left font-bold">Scan</th>
                                <th className="px-3 py-1 text-left font-bold">ASCII</th>
                            </tr>
                        </thead>
                        <tbody>
                            {buffer.map((entry, i) => (
                                <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/40">
                                    <td className="px-3 py-0.5 text-slate-500">{i}</td>
                                    <td className="px-3 py-0.5 text-amber-400">0x{entry.char.toString(16).padStart(2,'0').toUpperCase()}</td>
                                    <td className="px-3 py-0.5 text-blue-400">0x{entry.scan.toString(16).padStart(2,'0').toUpperCase()}</td>
                                    <td className="px-3 py-0.5 text-emerald-400">
                                        {entry.char >= 32 && entry.char <= 126 ? `'${String.fromCharCode(entry.char)}'` : '·'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function IOPortPanel({ bus, addLog }) {
    const [portStr, setPortStr] = React.useState('60');
    const [valStr, setValStr]   = React.useState('00');
    const [lastIn, setLastIn]   = React.useState(null); // { port, val } from last IN read

    const parseHex = (s, fallback = 0) => { const n = parseInt(s, 16); return isNaN(n) ? fallback : n; };

    const handleOut = () => {
        if (!bus) return;
        const port = parseHex(portStr) & 0xFFFF;
        const val  = parseHex(valStr)  & 0xFF;
        bus.write(port, val);
        addLog(`[Manual] OUT 0x${port.toString(16).toUpperCase().padStart(4,'0')}, 0x${val.toString(16).toUpperCase().padStart(2,'0')}`);
    };

    const handleIn = () => {
        if (!bus) return;
        const port = parseHex(portStr) & 0xFFFF;
        const val  = bus.read(port) & 0xFF;
        setLastIn({ port, val });
        addLog(`[Manual]  IN 0x${port.toString(16).toUpperCase().padStart(4,'0')} → 0x${val.toString(16).toUpperCase().padStart(2,'0')}`);
    };

    const fieldCls = 'w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[12px] font-mono focus:outline-none focus:border-cyan-500';

    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800">
                <h2 className="text-[10px] font-bold text-fuchsia-400 uppercase tracking-widest font-mono">I/O Port Access</h2>
            </div>
            <div className="px-4 py-3 space-y-3">
                <div className="flex gap-2 items-end">
                    <div className="flex-1">
                        <label className="block text-[9px] text-slate-500 font-mono mb-1">PORT (hex)</label>
                        <input
                            type="text" maxLength={4}
                            value={portStr}
                            onChange={e => setPortStr(e.target.value.replace(/[^0-9a-fA-F]/g,''))}
                            className={`${fieldCls} text-amber-400`}
                        />
                    </div>
                    <div className="flex-1">
                        <label className="block text-[9px] text-slate-500 font-mono mb-1">VALUE (hex)</label>
                        <input
                            type="text" maxLength={2}
                            value={valStr}
                            onChange={e => setValStr(e.target.value.replace(/[^0-9a-fA-F]/g,''))}
                            className={`${fieldCls} text-emerald-400`}
                        />
                    </div>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={handleOut}
                        className="flex-1 px-3 py-1.5 bg-fuchsia-700 hover:bg-fuchsia-600 text-white rounded text-[11px] font-bold transition-colors active:scale-95 font-mono"
                    >OUT →</button>
                    <button
                        onClick={handleIn}
                        className="flex-1 px-3 py-1.5 bg-cyan-800 hover:bg-cyan-700 text-white rounded text-[11px] font-bold transition-colors active:scale-95 font-mono"
                    >← IN</button>
                </div>
                {lastIn !== null && (
                    <div className="text-[10px] font-mono text-center text-cyan-300 bg-slate-800 rounded px-2 py-1">
                        IN 0x{lastIn.port.toString(16).toUpperCase().padStart(4,'0')} →{' '}
                        <span className="text-emerald-400 font-bold">
                            0x{lastIn.val.toString(16).toUpperCase().padStart(2,'0')}
                        </span>
                        {' '}({lastIn.val})
                    </div>
                )}
            </div>
        </div>
    );
}

function DiskViewer({ diskMemory }) {
    const BLOCKS_PER_PAGE = 64;
    const BLOCK_SIZE = 16;
    const TOTAL_BLOCKS = Math.floor(diskMemory.length / BLOCK_SIZE);
    const TOTAL_PAGES = Math.ceil(TOTAL_BLOCKS / BLOCKS_PER_PAGE);

    const [page, setPage] = React.useState(0);
    const [maximized, setMaximized] = React.useState(false);
    const pageStart = page * BLOCKS_PER_PAGE;

    return (
        <div className={maximized ? "fixed inset-0 z-50 flex flex-col bg-slate-900" : "bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-xl h-40"}>
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center gap-2">
                <h2 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest font-mono whitespace-nowrap">Virtual Disk</h2>
                <div className="flex items-center gap-2 ml-auto">
                    <button
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded disabled:opacity-30 transition-colors font-bold"
                    >◀</button>
                    <select
                        value={page}
                        onChange={e => setPage(Number(e.target.value))}
                        className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-amber-400 text-[10px] font-mono focus:outline-none focus:border-amber-500"
                    >
                        {Array.from({ length: TOTAL_PAGES }).map((_, p) => {
                            const blkStart = p * BLOCKS_PER_PAGE;
                            const byteStart = blkStart * BLOCK_SIZE;
                            return (
                                <option key={p} value={p}>
                                    {`Pg ${p}  0x${byteStart.toString(16).toUpperCase().padStart(5, '0')}–0x${(byteStart + BLOCKS_PER_PAGE * BLOCK_SIZE - 1).toString(16).toUpperCase().padStart(5, '0')}`}
                                </option>
                            );
                        })}
                    </select>
                    <button
                        onClick={() => setPage(p => Math.min(TOTAL_PAGES - 1, p + 1))}
                        disabled={page === TOTAL_PAGES - 1}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded disabled:opacity-30 transition-colors font-bold"
                    >▶</button>
                    <button
                        onClick={() => setMaximized(m => !m)}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors font-bold"
                        title={maximized ? 'Restore' : 'Maximize'}
                    >{maximized ? '↙ Restore' : '↗ Max'}</button>
                </div>
            </div>
            <div className={`p-3 overflow-auto flex-1 font-mono text-[9px] bg-slate-950/50 custom-scrollbar gap-2 ${maximized ? 'grid grid-cols-8' : 'grid grid-cols-4'}`}>
                {Array.from({ length: BLOCKS_PER_PAGE }).map((_, i) => {
                    const absBlock = pageStart + i;
                    const diskOff = absBlock * BLOCK_SIZE;
                    return (
                        <div key={i} className="flex flex-col border border-slate-800 p-1 rounded">
                            <span className="text-slate-600 mb-1">BLK {absBlock.toString(16).toUpperCase().padStart(4, '0')}</span>
                            <div className="flex flex-wrap gap-1">
                                {Array.from({ length: BLOCK_SIZE }).map((_, b) => (
                                    <span key={b} className={diskMemory[diskOff + b] !== 0 ? "text-amber-400" : "text-slate-900"}>
                                        {(diskMemory[diskOff + b] || 0).toString(16).toUpperCase().padStart(2, '0')}
                                    </span>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function FloppyDiskViewer({ floppyMemory, onLoadFloppy }) {
    const BLOCKS_PER_PAGE = 64;
    const BLOCK_SIZE = 16;
    const TOTAL_BLOCKS = Math.floor(floppyMemory.length / BLOCK_SIZE);
    const TOTAL_PAGES = Math.ceil(TOTAL_BLOCKS / BLOCKS_PER_PAGE);

    const [page, setPage] = React.useState(0);
    const [maximized, setMaximized] = React.useState(false);
    const fileInputRef = React.useRef(null);
    const pageStart = page * BLOCKS_PER_PAGE;

    const handleFileLoad = (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            onLoadFloppy && onLoadFloppy(new Uint8Array(e.target.result));
        };
        reader.readAsArrayBuffer(file);
        ev.target.value = '';
    };

    return (
        <div className={maximized ? "fixed inset-0 z-50 flex flex-col bg-slate-900" : "bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-xl h-40"}>
            <div className="bg-slate-950/50 px-4 py-2 border-b border-slate-800 flex justify-between items-center gap-2">
                <h2 className="text-[10px] font-bold text-cyan-500 uppercase tracking-widest font-mono whitespace-nowrap">Floppy Disk A:</h2>
                <div className="flex items-center gap-2 ml-auto">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".img,.flp,.bin"
                        className="hidden"
                        onChange={handleFileLoad}
                    />
                    <button
                        onClick={() => fileInputRef.current && fileInputRef.current.click()}
                        className="px-2 py-0.5 text-[10px] bg-cyan-800 hover:bg-cyan-700 text-slate-200 rounded transition-colors font-bold"
                        title="Load floppy image (.img/.flp/.bin)"
                    >📂 Load</button>
                    <button
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded disabled:opacity-30 transition-colors font-bold"
                    >◀</button>
                    <select
                        value={page}
                        onChange={e => setPage(Number(e.target.value))}
                        className="bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-cyan-400 text-[10px] font-mono focus:outline-none focus:border-cyan-500"
                    >
                        {Array.from({ length: TOTAL_PAGES }).map((_, p) => {
                            const blkStart = p * BLOCKS_PER_PAGE;
                            const byteStart = blkStart * BLOCK_SIZE;
                            return (
                                <option key={p} value={p}>
                                    {`Pg ${p}  0x${byteStart.toString(16).toUpperCase().padStart(6, '0')}–0x${(byteStart + BLOCKS_PER_PAGE * BLOCK_SIZE - 1).toString(16).toUpperCase().padStart(6, '0')}`}
                                </option>
                            );
                        })}
                    </select>
                    <button
                        onClick={() => setPage(p => Math.min(TOTAL_PAGES - 1, p + 1))}
                        disabled={page === TOTAL_PAGES - 1}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded disabled:opacity-30 transition-colors font-bold"
                    >▶</button>
                    <button
                        onClick={() => setMaximized(m => !m)}
                        className="px-2 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors font-bold"
                        title={maximized ? 'Restore' : 'Maximize'}
                    >{maximized ? '↙ Restore' : '↗ Max'}</button>
                </div>
            </div>
            <div className={`p-3 overflow-auto flex-1 font-mono text-[9px] bg-slate-950/50 custom-scrollbar gap-2 ${maximized ? 'grid grid-cols-8' : 'grid grid-cols-4'}`}>
                {Array.from({ length: BLOCKS_PER_PAGE }).map((_, i) => {
                    const absBlock = pageStart + i;
                    const diskOff = absBlock * BLOCK_SIZE;
                    return (
                        <div key={i} className="flex flex-col border border-slate-800 p-1 rounded">
                            <span className="text-slate-600 mb-1">BLK {absBlock.toString(16).toUpperCase().padStart(4, '0')}</span>
                            <div className="flex flex-wrap gap-1">
                                {Array.from({ length: BLOCK_SIZE }).map((_, b) => (
                                    <span key={b} className={floppyMemory[diskOff + b] !== 0 ? "text-cyan-400" : "text-slate-900"}>
                                        {(floppyMemory[diskOff + b] || 0).toString(16).toUpperCase().padStart(2, '0')}
                                    </span>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function MemoryViewer({ title = "Memory View", getMemByte, memSegStr, setMemSegStr, memOffStr, setMemOffStr, hasToggle = false, isToggled = false, onToggle, onMemoryChange, isRunning, onLoadMemory }) {
    const [maximized, setMaximized] = React.useState(false);
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
    const rowCount = maximized ? 32 : 8;
    for (let r = 0; r < rowCount; r++) { 
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
        <div className={maximized ? "fixed inset-0 z-50 flex flex-col bg-slate-900" : "bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-xl h-[230px]"}>
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
                    <button onClick={() => setMaximized(m => !m)} className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-all active:scale-95 ml-1 text-[11px]" title={maximized ? 'Restore' : 'Maximize'}>
                        {maximized ? '↙ Restore' : '↗ Max'}
                    </button>
                </div>
            </div>
            <div className="p-3 font-mono text-[11px] bg-slate-950/50 flex flex-col space-y-1.5 overflow-x-auto custom-scrollbar flex-1">
                {rows}
            </div>
        </div>
    );
}

function RegistersPanel({ eng, isRunning, handleRegChange, handleFlagChange, packFlags, hasBootSig, ioLogs, prevRegs, speakerRef }) {
    const e = eng.current;
    const prev = prevRegs;
    const [logMaximized, setLogMaximized] = React.useState(false);
    return (
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-3 shadow-xl flex flex-col">
            <div className="flex justify-between items-center mb-3 border-b border-slate-800 pb-1">
                <h2 className="text-xs font-bold text-slate-400 uppercase font-mono tracking-tighter">Registers</h2>
                <span className="text-[9px] text-slate-500 italic">Editable</span>
            </div>
            <div className="space-y-1 text-xs mb-3">
                {["AX", "BX", "CX", "DX", "SI", "DI", "SP", "BP", "CS", "DS", "SS", "ES", "IP"].map(reg => {
                    const changed = prev && prev.reg[reg] !== e.reg[reg];
                    return (
                        <div key={reg} className="flex justify-between items-center font-mono">
                            <span className={changed ? "text-yellow-300 font-bold" : "text-blue-400 font-bold"}>{reg}</span>
                            <input 
                                type="text"
                                defaultValue={toHex(e.reg[reg])}
                                key={`${reg}-${e.reg[reg]}`}
                                onBlur={(ev) => handleRegChange(reg, ev.target.value)}
                                disabled={isRunning}
                                className={`w-14 bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-right text-[11px] focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${changed ? "text-yellow-300 border-yellow-600" : "text-emerald-400"}`}
                            />
                        </div>
                    );
                })}
            </div>
            <div className="grid grid-cols-2 gap-1 text-[9px] uppercase font-bold border-t border-slate-800 pt-2">
                {[["ZF","CF"],["SF","OF"],["DF","IF"],["PF","AF"]].map(([f1,f2]) => [
                    <button key={f1} onClick={() => !isRunning && handleFlagChange(f1)} disabled={isRunning} className={`text-left transition-colors ${prev && prev.flags[f1] !== e.flags[f1] ? "text-yellow-300" : e.flags[f1] ? "text-emerald-400" : "text-slate-500"} ${!isRunning ? "hover:text-white cursor-pointer" : "cursor-default"}`}>{f1}: {e.flags[f1]}</button>,
                    <button key={f2} onClick={() => !isRunning && handleFlagChange(f2)} disabled={isRunning} className={`text-left transition-colors ${prev && prev.flags[f2] !== e.flags[f2] ? "text-yellow-300" : e.flags[f2] ? "text-emerald-400" : "text-slate-500"} ${!isRunning ? "hover:text-white cursor-pointer" : "cursor-default"}`}>{f2}: {e.flags[f2]}</button>
                ])}
            </div>
            
            <div className="mt-2 text-[11px] font-mono text-center text-fuchsia-400 bg-slate-950/80 py-1 rounded border border-slate-800">
                {packFlags(e).toString(2).padStart(16, '0').replace(/(.{4})/g, '$1 ').trim()}
            </div>
            
            <div className="mt-4 pt-4 border-t border-slate-800">
                <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">BIOS Status</div>
                <div className="text-[10px] space-y-1">
                    <div className="flex justify-between"><span>Boot Sig:</span> <span className={hasBootSig ? "text-emerald-500" : "text-red-500"}>{hasBootSig ? "0xAA55" : "MISSING"}</span></div>
                    <div className="flex justify-between"><span>Audio:</span> <span className={speakerRef.current?.beeping ? "text-amber-400" : "text-slate-600"}>{speakerRef.current?.beeping ? "ON" : "OFF"}</span></div>
                </div>
            </div>

            <div className={logMaximized ? "fixed inset-0 z-50 flex flex-col bg-slate-900 text-[10px] font-mono" : "mt-4 pt-4 border-t border-slate-800 text-[10px] font-mono"}>
                <div className={`flex justify-between items-center ${logMaximized ? "px-3 py-2 border-b border-slate-800" : "mb-1"}`}>
                    <span className="text-slate-400 font-bold">System Logs:</span>
                    <button onClick={() => setLogMaximized(m => !m)} className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-all active:scale-95 text-[11px]" title={logMaximized ? 'Restore' : 'Maximize'}>
                        {logMaximized ? '↙ Restore' : '↗ Max'}
                    </button>
                </div>
                <div className={`overflow-y-auto text-emerald-400/70 custom-scrollbar ${logMaximized ? "flex-1 p-3" : "h-40 mt-1"}`}>
                    {ioLogs.map((log, i) => <div key={i}>{">"} {log}</div>)}
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
    const prevRegsRef = useRef(null);
    const audioCtxRef = useRef(null);
    const oscRef = useRef(null);
    const busRef = useRef(null);
    const speakerRef = useRef(null);
    const picRef = useRef(null);
    const keyboardDeviceRef = useRef(null); // Ref to the KeyboardDevice instance
    const shiftStateRef = useRef(0);        // Bit0=RShift, Bit1=LShift, Bit2=Ctrl, Bit3=Alt

    const eng = useRef({
        reg: { AX: 0, BX: 0, CX: 0, DX: 0, SI: 0, DI: 0, SP: INITIAL_SP, BP: 0, CS: 0, DS: 0, SS: 0, ES: 0, IP: 0 },
        flags: { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 },
        mem: new Uint8Array(ADDR_SPACE),
        disk: new Uint8Array(DISK_SIZE),
        floppy: new Uint8Array(FLOPPY_SIZE),
        cursorX: 0,
        cursorY: 0
    });

    const addLog = (msg) => setIoLogs(prev => [...prev, msg].slice(-200));

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

    const handleLoadFloppy = useCallback((data) => {
        const e = eng.current;
        const len = Math.min(data.length, FLOPPY_SIZE);
        e.floppy.set(data.subarray(0, len));
        addLog(`Loaded ${len} bytes into Floppy A:`);
        forceRender();
    }, []);

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

    const handleFlagChange = (flag) => {
        eng.current.flags[flag] = eng.current.flags[flag] ? 0 : 1;
        forceRender();
    };

    const handleReset = () => {
        setIsRunning(false);
        isRunningRef.current = false;
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        prevRegsRef.current = null;
        const e = eng.current;
        Object.keys(e.reg).forEach(k => e.reg[k] = 0);
        e.reg.SP = INITIAL_SP;
        e.reg.CS = BIOS_ENTRY_SEG;
        e.reg.IP = BIOS_ENTRY_OFF;
        e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 };
        e.mem.fill(0);
        // Write reset vector at 0xFFFF:0x0000 — JMP FAR BIOS_ENTRY_SEG:BIOS_ENTRY_OFF
        writeMem8Safe(e, RESET_VECTOR_PHYS,     0xEA);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 1, BIOS_ENTRY_OFF & 0xFF);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 2, (BIOS_ENTRY_OFF >> 8) & 0xFF);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 3, BIOS_ENTRY_SEG & 0xFF);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 4, (BIOS_ENTRY_SEG >> 8) & 0xFF);
        e.cursorX = 0;
        e.cursorY = 0;
        setErrorMessage(null);
        forceRender();
    };

    const resetCPU = () => {
        const e = eng.current;
        Object.keys(e.reg).forEach(k => e.reg[k] = 0);
        e.reg.SP = INITIAL_SP;
        e.reg.CS = BIOS_ENTRY_SEG;
        e.reg.IP = BIOS_ENTRY_OFF;
        e.flags = { ZF: 0, SF: 0, CF: 0, OF: 0, DF: 0, IF: 1, AF: 0, PF: 0 };
        e.mem.fill(0);
        // Write reset vector at 0xFFFF:0x0000 — JMP FAR BIOS_ENTRY_SEG:BIOS_ENTRY_OFF
        writeMem8Safe(e, RESET_VECTOR_PHYS,     0xEA);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 1, BIOS_ENTRY_OFF & 0xFF);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 2, (BIOS_ENTRY_OFF >> 8) & 0xFF);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 3, BIOS_ENTRY_SEG & 0xFF);
        writeMem8Safe(e, RESET_VECTOR_PHYS + 4, (BIOS_ENTRY_SEG >> 8) & 0xFF);
        e.cursorX = 0;
        e.cursorY = 0;
        // Initialise BDA keyboard circular buffer so head == tail (empty)
        writeMemWord(e, BDA_KBD_HEAD_PHYS, BDA_KBD_BUF_OFF);
        writeMemWord(e, BDA_KBD_TAIL_PHYS, BDA_KBD_BUF_OFF);
        if (busRef.current) busRef.current.reset();
        setErrorMessage(null);
        setIoLogs([]);
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

    // IBM PC scan codes for common keys
    const SCAN_CODES = {
        'Escape': 0x01, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
        '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0A, '0': 0x0B, '-': 0x0C, '=': 0x0D,
        'Backspace': 0x0E, 'Tab': 0x0F,
        'q': 0x10, 'w': 0x11, 'e': 0x12, 'r': 0x13, 't': 0x14, 'y': 0x15, 'u': 0x16,
        'i': 0x17, 'o': 0x18, 'p': 0x19, '[': 0x1A, ']': 0x1B, 'Enter': 0x1C,
        'a': 0x1E, 's': 0x1F, 'd': 0x20, 'f': 0x21, 'g': 0x22, 'h': 0x23,
        'j': 0x24, 'k': 0x25, 'l': 0x26, ';': 0x27, "'": 0x28, '`': 0x29,
        '\\': 0x2B, 'z': 0x2C, 'x': 0x2D, 'c': 0x2E, 'v': 0x2F, 'b': 0x30,
        'n': 0x31, 'm': 0x32, ',': 0x33, '.': 0x34, '/': 0x35,
        ' ': 0x39,
        'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E, 'F5': 0x3F,
        'F6': 0x40, 'F7': 0x41, 'F8': 0x42, 'F9': 0x43, 'F10': 0x44,
        'ArrowUp': 0x48, 'ArrowLeft': 0x4B, 'ArrowRight': 0x4D, 'ArrowDown': 0x50,
        'Insert': 0x52, 'Delete': 0x53, 'Home': 0x47, 'End': 0x4F,
        'PageUp': 0x49, 'PageDown': 0x51,
    };
    // Uppercase / shifted chars share scan code with their base key
    const SHIFTED_SCAN = {
        'Q':0x10,'W':0x11,'E':0x12,'R':0x13,'T':0x14,'Y':0x15,'U':0x16,'I':0x17,'O':0x18,'P':0x19,
        'A':0x1E,'S':0x1F,'D':0x20,'F':0x21,'G':0x22,'H':0x23,'J':0x24,'K':0x25,'L':0x26,
        'Z':0x2C,'X':0x2D,'C':0x2E,'V':0x2F,'B':0x30,'N':0x31,'M':0x32,
        '!':0x02,'@':0x03,'#':0x04,'$':0x05,'%':0x06,'^':0x07,'&':0x08,'*':0x09,'(':0x0A,')':0x0B,
        '_':0x0C,'+':0x0D,'{':0x1A,'}':0x1B,'|':0x2B,':':0x27,'"':0x28,'~':0x29,'<':0x33,'>':0x34,'?':0x35,
    };
    // Extended (non-ASCII) keys: char=0, scan in high byte
    const EXTENDED_KEYS = new Set(['ArrowUp','ArrowLeft','ArrowRight','ArrowDown','Insert','Delete','Home','End','PageUp','PageDown','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10']);

    const handleKeyDown = (e) => {
        // Track shift/ctrl/alt state and mirror into BDA status byte
        if (e.key === 'Shift') {
            shiftStateRef.current |= e.location === 2 ? 0x01 : 0x02;
            writeMem8Safe(eng.current, BDA_KBD_STATUS1_PHYS, shiftStateRef.current & 0xFF);
            return;
        }
        if (e.key === 'Control') {
            shiftStateRef.current |= 0x04;
            writeMem8Safe(eng.current, BDA_KBD_STATUS1_PHYS, shiftStateRef.current & 0xFF);
            return;
        }
        if (e.key === 'Alt') {
            shiftStateRef.current |= 0x08;
            writeMem8Safe(eng.current, BDA_KBD_STATUS1_PHYS, shiftStateRef.current & 0xFF);
            return;
        }

        let charCode = 0;
        let scanCode = 0;

        if (e.key.length === 1) {
            charCode = e.key.charCodeAt(0);
            scanCode = SCAN_CODES[e.key] || SHIFTED_SCAN[e.key] || 0;
        } else if (e.key === 'Enter') {
            charCode = 0x0D; scanCode = 0x1C;
        } else if (e.key === 'Backspace') {
            charCode = 0x08; scanCode = 0x0E;
        } else if (e.key === 'Escape') {
            charCode = 0x1B; scanCode = 0x01;
        } else if (e.key === 'Tab') {
            charCode = 0x09; scanCode = 0x0F;
        } else if (EXTENDED_KEYS.has(e.key)) {
            charCode = 0x00; scanCode = SCAN_CODES[e.key] || 0;
        } else {
            return; // Ignore modifier-only keys
        }

        // Write entry into the BDA circular keyboard buffer.
        // head and tail store BDA-relative offsets (0x1E–0x3C).
        // Entry word: low byte = ASCII, high byte = scan code.
        const tail = readMemWord(eng.current, BDA_KBD_TAIL_PHYS);
        const nextTail = (tail + 2 >= BDA_KBD_BUF_END_OFF) ? BDA_KBD_BUF_OFF : tail + 2;
        const head = readMemWord(eng.current, BDA_KBD_HEAD_PHYS);
        if (nextTail !== head) { // buffer not full
            writeMemWord(eng.current, BDA_SEG_PHYS + tail, ((scanCode & 0xFF) << 8) | (charCode & 0xFF));
            writeMemWord(eng.current, BDA_KBD_TAIL_PHYS, nextTail);
        }

        // Also enqueue in the JS KeyboardDevice for display in the keyboard panel.
        keyboardDeviceRef.current.enqueue(charCode, scanCode);
        // Raise IRQ1 (keyboard) on the PIC
        if (picRef.current) picRef.current.raiseIRQ(1);
        forceRender();
    };

    const handleKeyUp = (e) => {
        if (e.key === 'Shift') {
            shiftStateRef.current &= e.location === 2 ? ~0x01 : ~0x02;
            writeMem8Safe(eng.current, BDA_KBD_STATUS1_PHYS, shiftStateRef.current & 0xFF);
        } else if (e.key === 'Control') {
            shiftStateRef.current &= ~0x04;
            writeMem8Safe(eng.current, BDA_KBD_STATUS1_PHYS, shiftStateRef.current & 0xFF);
        } else if (e.key === 'Alt') {
            shiftStateRef.current &= ~0x08;
            writeMem8Safe(eng.current, BDA_KBD_STATUS1_PHYS, shiftStateRef.current & 0xFF);
        }
    };

    // Initialize I/O bus and devices
    if (!busRef.current) {
        const bus = new IOBus();
        const speaker = new SpeakerDevice();
        speaker.playBeep = playBeep;
        speaker.stopAudio = stopAudio;
        const pic = new PIC8259Device();
        const keyboard = new KeyboardDevice();
        bus.register(new NullDevice());
        bus.register(speaker);
        bus.register(new DiskDevice());
        bus.register(keyboard);
        bus.register(pic);
        bus.attach(eng.current);
        bus.onLog = addLog;
        busRef.current = bus;
        speakerRef.current = speaker;
        picRef.current = pic;
        keyboardDeviceRef.current = keyboard;
    }

    const getCpuContext = () => ({
        bus: busRef.current,
        pic: picRef.current,
        keyboard: keyboardDeviceRef.current,
        shiftState: shiftStateRef.current,
    });

    const executeStepLocal = () => {
        return executeStep(eng.current, getCpuContext());
    };

    const stepUI = () => {
        try {
            const e = eng.current;
            const cs = e.reg.CS, ipBefore = e.reg.IP;
            prevRegsRef.current = { reg: { ...e.reg }, flags: { ...e.flags } };
            executeStepLocal();
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
        try { for (let i = 0; i < 20; i++) { if (!executeStepLocal()) { ok = false; break; } } } 
        catch (ex) { setErrorMessage(ex.message); ok = false; }
        forceRender();
        if (ok) requestRef.current = requestAnimationFrame(runLoop);
        else { setIsRunning(false); isRunningRef.current = false; }
    }, []);

    const clearPrevRegs = () => { prevRegsRef.current = null; };

    const toggleRun = () => {
        if (isRunning) {
            setIsRunning(false); isRunningRef.current = false;
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        } else {
            prevRegsRef.current = null;
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
        <div className="min-h-screen bg-slate-950 text-slate-200 p-4 font-mono selection:bg-blue-500/30" onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} tabIndex="0">
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
                        <VGAMonitor memory={e.mem} cs={e.reg.CS} ip={e.reg.IP} cursorX={e.cursorX} cursorY={e.cursorY} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} />
                        <KeyboardPanel keyboardDevice={keyboardDeviceRef.current} handleKeyDown={handleKeyDown} handleKeyUp={handleKeyUp} forceRender={forceRender} />
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
                        <FloppyDiskViewer floppyMemory={e.floppy} onLoadFloppy={handleLoadFloppy} />
                        <DiskViewer diskMemory={e.disk} />
                    </div>

                    <div className="lg:col-span-2 space-y-4">
                        <RegistersPanel eng={eng} isRunning={isRunning} handleRegChange={handleRegChange} handleFlagChange={handleFlagChange} packFlags={packFlags} hasBootSig={hasBootSig} ioLogs={ioLogs} prevRegs={prevRegsRef.current} speakerRef={speakerRef} />
                        <IOPortPanel bus={busRef.current} addLog={addLog} />
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