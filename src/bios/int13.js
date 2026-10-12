// INT 13h — disk services for the first floppy (DL=00h) and first hard disk (DL=80h).
// Reference: http://www.techhelpmanual.com/95-interrupts_and_bios_services.html
import { DISK_SIZE, SECTOR_SIZE, FLOPPY_SIZE, calcPhys, readMem8, writeMem8Safe, ADDR_SPACE } from '../CPU8086.js';
import { BDA, rb, wb } from './bda.js';

// Status codes (returned in AH)
const OK = 0x00;
const ERR_INVALID_COMMAND = 0x01;
const ERR_SECTOR_NOT_FOUND = 0x04;
const ERR_DRIVE_NOT_READY = 0x80;

// 3.5" 1.44 MB floppy
const FLOPPY = { heads: 2, sectorsPerTrack: 18, cylinders: 80, bytes: FLOPPY_SIZE, driveType: 0x04 };
// Virtual hard disk: flat 128 KB exposed as a 1-head geometry
const HDD_SPT = 63;
const HDD_HEADS = 1;
const HDD_SECTORS = Math.floor(DISK_SIZE / SECTOR_SIZE);
const HDD = { heads: HDD_HEADS, sectorsPerTrack: HDD_SPT, cylinders: Math.ceil(HDD_SECTORS / (HDD_HEADS * HDD_SPT)), bytes: DISK_SIZE };

const ret = (e, status) => {
    e.reg.AX = (e.reg.AX & 0x00FF) | (status << 8);   // AH = status, AL kept (sectors transferred)
    e.flags.CF = status === OK ? 0 : 1;
    wb(e, BDA.DISK_STATUS, status);
};

/** Decode CHS from CX/DX, check it against the geometry and move `count` sectors to/from ES:BX. */
const transfer = (e, geo, store, toMemory) => {
    const count = e.reg.AX & 0xFF;
    const cl = e.reg.CX & 0xFF;
    const sector = cl & 0x3F;                                  // 1-based
    const cylinder = ((e.reg.CX >> 8) & 0xFF) | ((cl & 0xC0) << 2);
    const head = (e.reg.DX >> 8) & 0xFF;

    if (count === 0 || sector === 0 || sector > geo.sectorsPerTrack || head >= geo.heads) return ret(e, ERR_SECTOR_NOT_FOUND);
    const lba = (cylinder * geo.heads + head) * geo.sectorsPerTrack + (sector - 1);
    const offset = lba * SECTOR_SIZE;
    if (offset + count * SECTOR_SIZE > geo.bytes) return ret(e, ERR_SECTOR_NOT_FOUND);

    const buf = calcPhys(e.reg.ES, e.reg.BX);
    for (let i = 0; i < count * SECTOR_SIZE; i++) {
        const addr = (buf + i) & (ADDR_SPACE - 1);
        if (toMemory) writeMem8Safe(e, addr, store[offset + i]);
        else store[offset + i] = readMem8(e, addr);
    }
    ret(e, OK);
};

const service = (e, ah, geo, store, isFloppy) => {
    switch (ah) {
        case 0x00: case 0x0D: case 0x11: ret(e, OK); break;                  // reset / alternate reset / recalibrate
        case 0x01: { const s = rb(e, BDA.DISK_STATUS); e.reg.AX = (e.reg.AX & 0x00FF) | (s << 8); e.flags.CF = s ? 1 : 0; break; } // last status
        case 0x02: transfer(e, geo, store, true); break;                    // read sectors
        case 0x03: transfer(e, geo, store, false); break;                   // write sectors
        case 0x04: case 0x0C: case 0x10: ret(e, OK); break;                 // verify / seek / test unit ready
        case 0x08: { // get drive parameters
            e.reg.AX = 0;
            e.reg.BX = isFloppy ? FLOPPY.driveType : 0;
            e.reg.CX = ((geo.cylinders - 1) & 0xFF) << 8 | (((geo.cylinders - 1) >> 2) & 0xC0) | geo.sectorsPerTrack;
            e.reg.DX = ((geo.heads - 1) << 8) | 0x01; // DH = last head, DL = number of drives
            e.flags.CF = 0;
            wb(e, BDA.DISK_STATUS, OK);
            break;
        }
        case 0x15: { // get disk type
            if (isFloppy) {
                e.reg.AX = (e.reg.AX & 0x00FF) | 0x0200;                     // floppy with change-line support
            } else {
                const total = geo.bytes / SECTOR_SIZE;
                e.reg.AX = (e.reg.AX & 0x00FF) | 0x0300;                     // fixed disk
                e.reg.CX = (total >> 16) & 0xFFFF;
                e.reg.DX = total & 0xFFFF;
            }
            e.flags.CF = 0;
            break;
        }
        case 0x16: if (isFloppy) ret(e, OK); else ret(e, ERR_INVALID_COMMAND); break; // floppy change-line status: not changed
        default: ret(e, ERR_INVALID_COMMAND);
    }
};

export const int13 = (e) => {
    const ah = (e.reg.AX >> 8) & 0xFF;
    const dl = e.reg.DX & 0xFF;
    if (dl === 0x00) service(e, ah, FLOPPY, e.floppy, true);
    else if (dl === 0x80) service(e, ah, HDD, e.disk, false);
    else if (dl === 0x01) ret(e, ERR_DRIVE_NOT_READY);       // no second floppy
    else ret(e, ERR_INVALID_COMMAND);                          // no such drive
};
