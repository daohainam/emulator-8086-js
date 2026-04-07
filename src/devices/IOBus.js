class IOBus {
    constructor() {
        this.ports = new Uint8Array(65536);
        this.devices = [];
        this.portMap = new Map();
        this.engine = null;
        this.pic = null;
        this.onLog = null;
    }

    attach(engine) {
        this.engine = engine;
    }

    register(device) {
        this.devices.push(device);
        for (const port of device.getPortRange()) {
            if (!this.portMap.has(port)) {
                this.portMap.set(port, []);
            }
            this.portMap.get(port).push(device);
        }
        // Auto-detect PIC device
        if (device.constructor.name === 'PIC8259Device') {
            this.pic = device;
        }
    }

    raiseIRQ(irq) {
        if (this.pic) this.pic.raiseIRQ(irq);
    }

    lowerIRQ(irq) {
        if (this.pic) this.pic.lowerIRQ(irq);
    }

    read(port) {
        const p = port & 0xFFFF;
        const interested = this.portMap.get(p);
        if (interested) {
            for (let i = 0; i < interested.length; i++) {
                const val = interested[i].onRead(p, this);
                if (val !== undefined) return val & 0xFF;
            }
        }
        return this.ports[p];
    }

    readWord(port) {
        return this.read(port) | (this.read((port + 1) & 0xFFFF) << 8);
    }

    write(port, val) {
        const p = port & 0xFFFF;
        const v = val & 0xFF;
        this.ports[p] = v;

        const interested = this.portMap.get(p);
        if (interested) {
            for (let i = 0; i < interested.length; i++) {
                interested[i].onWrite(p, v, this);
            }
        }

        if (this.onLog) {
            this.onLog(`OUT 0x${p.toString(16).toUpperCase()}: 0x${v.toString(16).toUpperCase()}`);
        }
    }

    writeWord(port, val) {
        this.write(port, val & 0xFF);
        this.write((port + 1) & 0xFFFF, (val >> 8) & 0xFF);
    }

    poke(port, val) {
        this.ports[port & 0xFFFF] = val & 0xFF;
    }

    reset() {
        this.ports.fill(0);
        for (const device of this.devices) {
            device.reset(this);
        }
    }
}

export { IOBus };
