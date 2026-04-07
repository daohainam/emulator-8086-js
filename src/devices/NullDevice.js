import { IODevice } from './IODevice.js';

class NullDevice extends IODevice {
    constructor() {
        super('NullDevice');
    }

    getPortRange() {
        return [];
    }

    onWrite(_port, _val, _bus) {
    }

    reset(_bus) {
    }
}

export { NullDevice };
