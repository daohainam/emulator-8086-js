// INT 16h — keyboard services, backed by the circular keyboard buffer in the BDA.
// Each entry is a word: low byte = ASCII code, high byte = scan code. Empty when head == tail.
import { BDA, KBD_BUF_START_OFF, KBD_BUF_END_OFF, rb, rw, ww } from './bda.js';

const BDA_SEG_PHYS = 0x400;

const advance = (offset) => (offset + 2 >= KBD_BUF_END_OFF ? KBD_BUF_START_OFF : offset + 2);

export const keyAvailable = (e) => rw(e, BDA.KBD_HEAD) !== rw(e, BDA.KBD_TAIL);

/** Append a keystroke to the buffer. Returns false when the buffer is full. */
export const enqueueKey = (e, ascii, scan) => {
    const tail = rw(e, BDA.KBD_TAIL);
    const next = advance(tail);
    if (next === rw(e, BDA.KBD_HEAD)) return false;
    ww(e, BDA_SEG_PHYS + tail, ((scan & 0xFF) << 8) | (ascii & 0xFF));
    ww(e, BDA.KBD_TAIL, next);
    return true;
};

/**
 * @returns {'retry'|undefined} 'retry' when a blocking read must wait for a key
 */
export const int16 = (e) => {
    const ah = (e.reg.AX >> 8) & 0xFF;

    switch (ah) {
        case 0x00: case 0x10: { // wait for a key and remove it from the buffer
            if (!keyAvailable(e)) return 'retry';
            const head = rw(e, BDA.KBD_HEAD);
            e.reg.AX = rw(e, BDA_SEG_PHYS + head);
            ww(e, BDA.KBD_HEAD, advance(head));
            break;
        }
        case 0x01: case 0x11: // peek: ZF=1 when empty, otherwise AX = next key (not removed)
            if (!keyAvailable(e)) e.flags.ZF = 1;
            else { e.flags.ZF = 0; e.reg.AX = rw(e, BDA_SEG_PHYS + rw(e, BDA.KBD_HEAD)); }
            break;
        case 0x02: // shift flags
            e.reg.AX = (e.reg.AX & 0xFF00) | rb(e, BDA.KBD_FLAGS1);
            break;
        case 0x05: // store a keystroke (CH = scan, CL = ASCII); AL = 0 ok, 1 buffer full
            e.reg.AX = (e.reg.AX & 0xFF00) | (enqueueKey(e, e.reg.CX & 0xFF, (e.reg.CX >> 8) & 0xFF) ? 0 : 1);
            break;
        case 0x03: break; // set typematic rate: accepted, nothing to configure
        case 0x12: // extended shift flags: AL = flags 1, AH = flags 2
            e.reg.AX = (rb(e, BDA.KBD_FLAGS2) << 8) | rb(e, BDA.KBD_FLAGS1);
            break;
        default: break;
    }
    return undefined;
};
