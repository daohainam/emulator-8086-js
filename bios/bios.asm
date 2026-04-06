; =============================================================================
; 8086 Emulator BIOS Extension ROM
; Loaded at 0xC000:0x0000
;
; Provides stub handlers for:
;   INT 0x10 - Video Services
;   INT 0x13 - Disk Services
;   INT 0x16 - Keyboard Services
;
; A common handler is installed for all other interrupts; it writes an error
; message to the top-left corner of the video screen, sets AX=1, and returns.
; =============================================================================

[bits 16]
[org 0]

ROM_SEG  equ 0xC000         ; Segment where this ROM is loaded
ROM_SIZE equ 8192           ; 8 KB = 16 * 512 bytes

; =============================================================================
; ROM Header (required for BIOS extension ROM detection by POST)
; =============================================================================
db 0x55                     ; Signature byte 1
db 0xAA                     ; Signature byte 2
db (ROM_SIZE / 512)         ; Size in 512-byte blocks (0x10 = 16 blocks = 8 KB)

; POST performs a far call to 0xC000:0003, so the init entry must be here.
jmp near init

; =============================================================================
; Data
; =============================================================================
err_msg  db 'Unhandled interrupt!', 0

; =============================================================================
; Initialization routine
; Called by POST via far call to 0xC000:0003.
; Installs INT 0x10, 0x13, and 0x16 vectors, then returns far.
; =============================================================================
init:
    push ax
    push bx
    push cx
    push es

    xor ax, ax
    mov es, ax              ; ES = 0 (IVT segment)

    ; Install common_handler for all 256 interrupt vectors
    xor bx, bx              ; BX = IVT byte offset (starts at 0)
    mov cx, 256
.ivt_loop:
    mov word [es:bx],     common_handler
    mov word [es:bx + 2], ROM_SEG
    add bx, 4
    loop .ivt_loop

    ; Override with specific handlers for INT 0x10, 0x13, 0x16

    ; Install INT 0x10 (Video Services) handler
    mov word [es:0x10 * 4],     int10_handler
    mov word [es:0x10 * 4 + 2], ROM_SEG

    ; Install INT 0x13 (Disk Services) handler
    mov word [es:0x13 * 4],     int13_handler
    mov word [es:0x13 * 4 + 2], ROM_SEG

    ; Install INT 0x16 (Keyboard Services) handler
    mov word [es:0x16 * 4],     int16_handler
    mov word [es:0x16 * 4 + 2], ROM_SEG

    pop es
    pop cx
    pop bx
    pop ax
    retf                    ; Return far to POST

; =============================================================================
; INT 0x10 - Video Services (stub)
; Sets AX=1 (error), CF=1, and returns.
; =============================================================================
int10_handler:
    mov ax, 0x0001          ; Error code
    stc                     ; Carry flag set = error
    iret

; =============================================================================
; INT 0x13 - Disk Services (stub)
; Sets AX=1 (error), CF=1, and returns.
; =============================================================================
int13_handler:
    mov ax, 0x0001          ; Error code
    stc                     ; Carry flag set = error
    iret

; =============================================================================
; INT 0x16 - Keyboard Services (stub)
; Sets AX=1 (error), CF=1, and returns.
; =============================================================================
int16_handler:
    mov ax, 0x0001          ; Error code
    stc                     ; Carry flag set = error
    iret

; =============================================================================
; Common Interrupt Handler
; Called for any unhandled interrupt.
; Saves all registers, writes an error message directly to video memory
; (CGA text mode at 0xB800:0000), restores all registers, sets AX=1, and
; returns via IRET.
; =============================================================================
common_handler:
    ; Save all registers (AX is not preserved: it holds the error return code)
    push bx
    push cx
    push dx
    push si
    push di
    push bp
    push ds
    push es

    ; Point ES:DI at top-left of CGA text video memory
    mov ax, 0xB800
    mov es, ax
    xor di, di              ; Offset 0 = row 0, column 0

    ; Point DS:SI at error message (in this ROM's code segment)
    push cs
    pop ds
    mov si, err_msg

.write_loop:
    lodsb                   ; AL = next character from err_msg
    test al, al             ; Null terminator?
    jz .done
    mov ah, 0x4F            ; Attribute: white text on red background
    stosw                   ; Write character + attribute to video memory
    jmp .write_loop

.done:
    ; Restore all saved registers
    pop es
    pop ds
    pop bp
    pop di
    pop si
    pop dx
    pop cx
    pop bx

    mov ax, 1               ; Return error code in AX
    iret

; =============================================================================
; Pad ROM image to exactly ROM_SIZE bytes
; =============================================================================
times (ROM_SIZE - ($ - $$)) db 0
