import { IODevice } from './IODevice.js';

class DiskDevice extends IODevice {
    constructor() {
        super('Disk');
        this.sectorSelect = 0;
    }

    getPortRange() {
        return [0x70, 0x71];
    }

    onWrite(port, val, bus) {
        const engine = bus.engine;
        if (!engine) return;

        if (port === 0x70) {
            this.sectorSelect = val % 256;
            return;
        }

        if (port === 0x71) {
            const rAddr = ((engine.reg.DS << 4) + engine.reg.BX) & 0xFFFFF;
            const dAddr = this.sectorSelect * 16;

            if (val === 1) {
                for (let i = 0; i < 16; i++) {
                    const phys = (rAddr + i) & 0xFFFFF;
                    if (phys < engine.mem.length) {
                        engine.mem[phys] = engine.disk[dAddr + i];
                    }
                }
            }
            if (val === 2) {
                for (let i = 0; i < 16; i++) {
                    engine.disk[dAddr + i] = engine.mem[(rAddr + i) & 0xFFFFF];
                }
            }
        }
    }

    reset(_bus) {
        this.sectorSelect = 0;
    }
}

export { DiskDevice };
