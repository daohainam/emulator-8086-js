import { IODevice } from './IODevice.js';

class KeyboardDevice extends IODevice {
    constructor() {
        super('Keyboard');
    }

    getPortRange() {
        return [0x60];
    }

    onWrite(_port, _val, _bus) {
    }

    reset(bus) {
        bus.poke(0x60, 0);
    }
}

export { KeyboardDevice };
