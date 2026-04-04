ORG 100h            ; Directive for COM programs

START:
    MOV AX, 0B800h  ; Point AX to Video Memory segment
    MOV ES, AX      ; Load Extra Segment with 0B800h
    XOR DI, DI      ; Set DI to 0 (top-left corner of screen)

    LEA SI, msg     ; Load address of our string
    MOV CX, 11      ; Length of "Hello World"

PRINT_LOOP:
    LODSB           ; Load next character from [DS:SI] into AL
    MOV ES:[DI], AL ; Write ASCII char to video memory
    INC DI
    MOV BYTE [ES:DI], 0Eh ; Write attribute (Yellow on Black)
    INC DI
    LOOP PRINT_LOOP ; Repeat for all characters

    HLT             ; Return to OS

msg DB 'Hello World'
