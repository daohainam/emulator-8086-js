import { IODevice } from './IODevice.js';

/**
 * Intel 8259A Programmable Interrupt Controller (PIC) simulation.
 *
 * Ports (master):
 *   0x20 – command register (write: ICW1/OCW2/OCW3, read: IRR or ISR)
 *   0x21 – data register   (write: ICW2-4/OCW1,     read: IMR)
 *
 * Standard PC/XT vector offset: 0x08  (IRQ0 → INT 08h … IRQ7 → INT 0Fh)
 */
class PIC8259Device extends IODevice {
    constructor(basePort = 0x20) {
        super('PIC8259');
        this.basePort = basePort;

        // Core registers
        this.irr = 0;    // Interrupt Request Register  (pending requests)
        this.isr = 0;    // In-Service Register         (currently being serviced)
        this.imr = 0xFF; // Interrupt Mask Register      (all masked by default)

        // Initialization Command Words
        this.vectorOffset = 0x08; // ICW2: base vector (default PC/XT mapping)
        this.icw4Needed = false;
        this.singleMode = true;   // true = single PIC, false = cascade
        this.levelTriggered = false;
        this.autoEOI = false;

        // Initialization state machine
        this.initStep = 0;  // 0 = operational, 1 = awaiting ICW2, 2 = ICW3, 3 = ICW4

        // OCW3 read-back selection: false = read IRR, true = read ISR
        this.readISR = false;

        // Edge-trigger tracking: previous IRQ line states for edge detection
        this.irqLines = 0;
    }

    getPortRange() {
        return [this.basePort, this.basePort + 1];
    }

    // --- External interface for devices ---

    /**
     * Raise an IRQ line (assert high).
     * In edge-triggered mode, the request is latched on rising edge.
     * In level-triggered mode, the request persists while the line is held.
     */
    raiseIRQ(irq) {
        if (irq < 0 || irq > 7) return;
        const mask = 1 << irq;
        if (this.levelTriggered) {
            this.irr |= mask;
            this.irqLines |= mask;
        } else {
            // Edge-triggered: only set IRR on rising edge (0→1)
            if (!(this.irqLines & mask)) {
                this.irr |= mask;
            }
            this.irqLines |= mask;
        }
    }

    /**
     * Lower (de-assert) an IRQ line.
     * In level-triggered mode this also clears the IRR bit.
     */
    lowerIRQ(irq) {
        if (irq < 0 || irq > 7) return;
        const mask = 1 << irq;
        this.irqLines &= ~mask;
        if (this.levelTriggered) {
            this.irr &= ~mask;
        }
    }

    /**
     * Called by the CPU after each instruction when IF=1.
     * Returns the interrupt vector number (0-255) if there is a pending,
     * unmasked interrupt of higher priority than what is currently in service.
     * Returns -1 if no interrupt should fire.
     *
     * On acknowledge, the IRR bit is cleared and the ISR bit is set.
     * If autoEOI is enabled, the ISR bit is cleared immediately.
     */
    acknowledge() {
        const pending = this.irr & ~this.imr;
        if (pending === 0) return -1;

        // Find the highest-priority pending interrupt (lowest bit number)
        for (let i = 0; i < 8; i++) {
            const mask = 1 << i;
            if (!(pending & mask)) continue;

            // Check priority: cannot service if a higher-priority (lower number)
            // interrupt is already in service
            const higherPriorityISR = this.isr & (mask - 1); // bits below current
            if (higherPriorityISR) return -1; // blocked by higher-priority ISR

            // Acknowledge this interrupt
            this.irr &= ~mask;
            if (!this.autoEOI) {
                this.isr |= mask;
            }
            return this.vectorOffset + i;
        }
        return -1;
    }

    /**
     * Check whether a hardware interrupt is pending without acknowledging it.
     */
    hasPendingInterrupt() {
        const pending = this.irr & ~this.imr;
        if (pending === 0) return false;
        for (let i = 0; i < 8; i++) {
            const mask = 1 << i;
            if (!(pending & mask)) continue;
            if (this.isr & (mask - 1)) return false;
            return true;
        }
        return false;
    }

    // --- I/O port handlers ---

    onWrite(port, val, _bus) {
        if (port === this.basePort) {
            this._writeCommand(val);
        } else if (port === this.basePort + 1) {
            this._writeData(val);
        }
    }

    onRead(port, _bus) {
        if (port === this.basePort) {
            // Return IRR or ISR depending on last OCW3
            return this.readISR ? this.isr : this.irr;
        }
        if (port === this.basePort + 1) {
            return this.imr;
        }
        return undefined;
    }

    // --- Initialization & command parsing ---

    _writeCommand(val) {
        if (val & 0x10) {
            // ICW1: bit 4 = 1
            this._startInit(val);
            return;
        }

        if (!(val & 0x08)) {
            // OCW2: bit 4=0, bit 3=0
            this._handleOCW2(val);
        } else {
            // OCW3: bit 4=0, bit 3=1
            this._handleOCW3(val);
        }
    }

    _writeData(val) {
        if (this.initStep > 0) {
            this._continueInit(val);
            return;
        }
        // OCW1: set IMR
        this.imr = val & 0xFF;
    }

    _startInit(icw1) {
        // ICW1 fields
        this.levelTriggered = !!(icw1 & 0x08); // bit 3: 1=level, 0=edge
        this.singleMode     = !!(icw1 & 0x02); // bit 1: 1=single, 0=cascade
        this.icw4Needed     = !!(icw1 & 0x01); // bit 0: 1=ICW4 needed

        // Reset internal state
        this.isr = 0;
        this.imr = 0;
        this.irr = 0;
        this.readISR = false;
        this.autoEOI = false;

        this.initStep = 1; // next write to data port is ICW2
    }

    _continueInit(val) {
        switch (this.initStep) {
            case 1: // ICW2: vector offset (upper 5 bits for 8086)
                this.vectorOffset = val & 0xF8;
                if (!this.singleMode) {
                    this.initStep = 2; // ICW3 next
                } else if (this.icw4Needed) {
                    this.initStep = 3; // ICW4 next
                } else {
                    this.initStep = 0; // done
                }
                break;
            case 2: // ICW3: cascade configuration (ignored for single PIC sim)
                if (this.icw4Needed) {
                    this.initStep = 3;
                } else {
                    this.initStep = 0;
                }
                break;
            case 3: // ICW4
                this.autoEOI = !!(val & 0x02); // bit 1: auto EOI
                // bit 0: 8086 mode (always true in our emulator)
                this.initStep = 0; // initialization complete
                break;
            default:
                this.initStep = 0;
        }
    }

    _handleOCW2(val) {
        const cmd = (val >> 5) & 0x07;
        const irqLevel = val & 0x07;

        switch (cmd) {
            case 0x01: // Non-specific EOI
                this._nonSpecificEOI();
                break;
            case 0x03: // Specific EOI
                this.isr &= ~(1 << irqLevel);
                break;
            case 0x05: // Non-specific EOI + rotate (simplified: just do EOI)
                this._nonSpecificEOI();
                break;
            case 0x07: // Specific EOI + rotate (simplified: just do specific EOI)
                this.isr &= ~(1 << irqLevel);
                break;
            default:
                // Other rotation modes – not commonly used, ignore
                break;
        }
    }

    _nonSpecificEOI() {
        // Clear the highest-priority (lowest bit) ISR bit
        for (let i = 0; i < 8; i++) {
            if (this.isr & (1 << i)) {
                this.isr &= ~(1 << i);
                break;
            }
        }
    }

    _handleOCW3(val) {
        // bits 1-0: read register command
        if (val & 0x02) {
            this.readISR = !!(val & 0x01); // 10=read IRR, 11=read ISR
        }
    }

    reset(_bus) {
        this.irr = 0;
        this.isr = 0;
        this.imr = 0xFF;
        this.vectorOffset = 0x08;
        this.icw4Needed = false;
        this.singleMode = true;
        this.levelTriggered = false;
        this.autoEOI = false;
        this.initStep = 0;
        this.readISR = false;
        this.irqLines = 0;
    }
}

export { PIC8259Device };
