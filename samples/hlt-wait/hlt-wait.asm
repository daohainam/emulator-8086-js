; HLT as "sleep until an interrupt": the CPU idles in HLT and the keyboard wakes it.
;
; The program installs its own INT 9 (keyboard) handler, unmasks IRQ1 on the 8259 PIC and
; waits with HLT. A key press raises IRQ1; the handler reads the scan code from port 60h
; and signals the main loop. HLT with interrupts disabled (or with nothing able to wake
; the CPU) stops the emulator, which is how this program ends.
ORG 100h

    xor ax, ax
    mov es, ax
    cli
    mov word [es:9*4], kbd_isr      ; INT 9 = IRQ1 = keyboard
    mov [es:9*4+2], cs
    in al, 0x21                     ; PIC interrupt mask register
    and al, 0xFD                    ; clear bit 1: unmask IRQ1
    out 0x21, al
    sti

    mov si, waiting
    call print

wait_for_key:
    hlt                             ; sleep until an interrupt arrives
    cmp byte [scan], 0
    je wait_for_key                 ; woken by something else: sleep again

    mov si, got_key
    call print
    cli
    hlt                             ; IF = 0: nothing can wake the CPU, the emulator stops

kbd_isr:
    push ax
    in al, 0x60                     ; scan code from the keyboard controller
    test al, 0x80                   ; bit 7 = key release, ignore
    jnz .done
    mov [cs:scan], al
.done:
    mov al, 0x20                    ; end of interrupt
    out 0x20, al
    pop ax
    iret

print:                              ; print the zero-terminated string at DS:SI
    lodsb
    cmp al, 0
    je .end
    mov ah, 0x0E
    int 10h
    jmp print
.end:
    ret

scan    db 0
waiting db 'Press a key...', 13, 10, 0
got_key db 'Key!', 0
