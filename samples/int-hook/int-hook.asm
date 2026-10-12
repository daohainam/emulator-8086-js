; Hook INT 10h: count every call, then chain to the original BIOS handler.
;
; INT n always goes through the interrupt vector table, so a program can replace a BIOS
; vector, do some work and jump on to the old handler -- exactly like a DOS TSR would.
ORG 100h

    xor ax, ax
    mov es, ax                      ; ES = segment of the interrupt vector table (0000h)

    mov ax, [es:0x10*4]             ; save the original INT 10h vector (offset, segment)
    mov [old_ip], ax
    mov ax, [es:0x10*4+2]
    mov [old_cs], ax

    cli
    mov word [es:0x10*4], hook      ; install our handler
    mov [es:0x10*4+2], cs
    sti

    mov si, msg
print:
    lodsb
    cmp al, 0
    je restore
    mov ah, 0x0E                    ; teletype output -- goes through the hook first
    int 10h
    jmp print

restore:
    cli
    mov ax, [old_ip]                ; put the BIOS vector back
    mov [es:0x10*4], ax
    mov ax, [old_cs]
    mov [es:0x10*4+2], ax
    sti

    mov al, [calls]                 ; the hook saw one call per character
    add al, '0'
    mov ah, 0x0E
    int 10h
    hlt

hook:
    inc byte [cs:calls]
    pushf                           ; fake an INT so the BIOS handler can IRET back to us
    call far [cs:old_ip]
    iret

old_ip dw 0
old_cs dw 0
calls  db 0
msg    db 'Hooked: ', 0
