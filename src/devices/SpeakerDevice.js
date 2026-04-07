import { IODevice } from './IODevice.js';

const PC_TIMER_FREQ = 1193182;

class SpeakerDevice extends IODevice {
    constructor() {
        super('Speaker');
        this.t2Div = 0;
        this.t2High = false;
        this.freq = 0;
        this.beeping = false;
        this.playBeep = null;
        this.stopAudio = null;
    }

    getPortRange() {
        return [0x42, 0x61];
    }

    onWrite(port, val, _bus) {
        if (port === 0x42) {
            if (!this.t2High) {
                this.t2Div = val;
                this.t2High = true;
            } else {
                this.t2Div |= (val << 8);
                this.t2High = false;
                if (this.t2Div > 0) {
                    this.freq = PC_TIMER_FREQ / this.t2Div;
                }
            }
        }

        if (port === 0x61) {
            const enable = (val & 0x03) === 0x03;
            if (enable && !this.beeping) {
                this.beeping = true;
                if (this.playBeep) this.playBeep(this.freq);
            } else if (!enable && this.beeping) {
                this.beeping = false;
                if (this.stopAudio) this.stopAudio();
            }
        }
    }

    reset(_bus) {
        this.t2Div = 0;
        this.t2High = false;
        this.freq = 0;
        if (this.beeping && this.stopAudio) this.stopAudio();
        this.beeping = false;
    }
}

export { SpeakerDevice };
