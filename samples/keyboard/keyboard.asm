
ORG 100h

    ; Clear screen (INT 10h AH=06, AL=0 = clear all)
    mov ax, 0x0600
    mov bh, 0x07        ; White on black attribute
    mov cx, 0x0000      ; Top-left corner (row 0, col 0)
    mov dx, 0x184F      ; Bottom-right corner (row 24, col 79)
    int 10h

    ; Move cursor to row 0, col 0
    mov ah, 0x02
    mov bh, 0x00
    mov dh, 0x00
    mov dl, 0x00
    int 10h

    ; Print the prompt string
    mov si, prompt
print_prompt:
    lodsb               ; Load next char from [SI] into AL
    cmp al, 0
    je read_loop        ; Stop at null terminator
    mov ah, 0x0E        ; Teletype output
    mov bh, 0x00
    int 10h
    jmp print_prompt

    ; Main keyboard echo loop
read_loop:
    mov ah, 0x00        ; INT 16h AH=0: wait for and read a key
    int 16h             ; AL = ASCII char, AH = scan code

    cmp al, 0x1B        ; ESC key?
    je done             ; Yes — stop

    mov ah, 0x0E        ; INT 10h AH=0Eh: teletype output
    mov bh, 0x00
    int 10h             ; Display the character

    jmp read_loop       ; Back for next key

done:
    hlt

prompt:
    db 'Keyboard echo demo - type anything, ESC to stop', 13, 10
    db '> ', 0