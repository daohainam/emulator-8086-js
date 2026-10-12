// Small BIOS services: INT 11h, 12h, 15h, 1Ah and the default vector handlers.
import { BDA, rb, wb, rw, ww, refreshTicks } from './bda.js';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);

/** INT 11h — equipment list. */
export const int11 = (e) => { e.reg.AX = rw(e, BDA.EQUIPMENT); };

/** INT 12h — conventional memory size in KB. */
export const int12 = (e) => { e.reg.AX = rw(e, BDA.MEM_KB); };

/** INT 15h — system services. An 8086-class machine has no extended memory and no AT services. */
export const int15 = (e) => {
    const ah = (e.reg.AX >> 8) & 0xFF;
    switch (ah) {
        case 0x86: e.flags.CF = 0; break;                                      // wait CX:DX microseconds (elapsed instantly)
        case 0x88: e.reg.AX = 0; e.flags.CF = 0; break;                        // extended memory size: none
        default: e.reg.AX = (e.reg.AX & 0x00FF) | 0x8600; e.flags.CF = 1; break; // unsupported function
    }
};

/** INT 1Ah — time of day (tick counter from the BDA, RTC time/date from the host clock). */
export const int1a = (e) => {
    const ah = (e.reg.AX >> 8) & 0xFF;
    const now = new Date();
    switch (ah) {
        case 0x00: { // read tick count; AL = midnight flag (cleared by the read)
            refreshTicks(e, now.getTime());
            e.reg.CX = rw(e, BDA.TICKS + 2);
            e.reg.DX = rw(e, BDA.TICKS);
            e.reg.AX = (e.reg.AX & 0xFF00) | rb(e, BDA.MIDNIGHT);
            wb(e, BDA.MIDNIGHT, 0);
            break;
        }
        case 0x01: // set tick count
            ww(e, BDA.TICKS + 2, e.reg.CX);
            ww(e, BDA.TICKS, e.reg.DX);
            break;
        case 0x02: // read RTC time (BCD)
            e.reg.CX = (bcd(now.getHours()) << 8) | bcd(now.getMinutes());
            e.reg.DX = (bcd(now.getSeconds()) << 8);
            e.flags.CF = 0;
            break;
        case 0x04: { // read RTC date (BCD)
            const year = now.getFullYear();
            e.reg.CX = (bcd(Math.floor(year / 100)) << 8) | bcd(year % 100);
            e.reg.DX = (bcd(now.getMonth() + 1) << 8) | bcd(now.getDate());
            e.flags.CF = 0;
            break;
        }
        case 0x03: case 0x05: e.flags.CF = 0; break; // set RTC time/date: accepted, host clock is authoritative
        default: e.flags.CF = 1; break;
    }
};

/** Default handler for hardware IRQ vectors nobody hooked: acknowledge so the PIC keeps working. */
export const irqEoi = (_e, ctx) => { if (ctx && ctx.pic) ctx.pic.eoi(); };

const stackedCsIp = (e) => {
    const sp = e.reg.SP;
    const phys = (off) => ((e.reg.SS << 4) + ((sp + off) & 0xFFFF)) & 0xFFFFF;
    return { ip: e.mem[phys(0)] | (e.mem[phys(1)] << 8), cs: e.mem[phys(2)] | (e.mem[phys(3)] << 8) };
};

/** Unhandled CPU exceptions stop the machine with a readable message instead of running garbage. */
const fatal = (what) => (e) => {
    const { cs, ip } = stackedCsIp(e);
    e.fault = `${what} at ${hex2(cs >> 8)}${hex2(cs & 0xFF)}:${hex2(ip >> 8)}${hex2(ip & 0xFF)}`;
    return 'stop';
};
export const fatalDivide = fatal('Divide error (INT 0)');
export const fatalInvalidOpcode = fatal('Invalid opcode (INT 6)');
