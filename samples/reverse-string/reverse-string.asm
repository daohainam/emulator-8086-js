[org 0x100]          ; Điểm bắt đầu chuẩn cho chương trình COM (hoặc .bin)

start:
    ; 1. Thiết lập đoạn dữ liệu và đoạn video
    mov ax, 0B800h   ; Địa chỉ đoạn của bộ nhớ video màu (VGA)
    mov es, ax       ; ES trỏ tới bộ nhớ video
    mov ax, ds
    mov ds, ax       ; DS trỏ tới đoạn dữ liệu của chương trình

    ; 2. Tính toán độ dài chuỗi
    mov si, message
    xor cx, cx       ; Xóa CX để đếm độ dài
count_loop:
    cmp byte [si], 0 ; Kiểm tra ký tự kết thúc (null terminator)
    je found_end
    inc si
    inc cx
    jmp count_loop

found_end:
    ; 3. SI hiện đang ở vị trí kết thúc, lùi lại 1 để trỏ vào ký tự cuối cùng
    dec si
    
    ; 4. Thiết lập vị trí hiển thị trên màn hình (DI)
    ; Mỗi ký tự trên màn hình chiếm 2 byte: [Ký tự ASCII][Thuộc tính màu]
    mov di, 0        ; Bắt đầu từ góc trên bên trái (dòng 0, cột 0)

reverse_print:
    ; Lấy ký tự từ cuối chuỗi
    mov al, [si]
    
    ; Ghi vào bộ nhớ video
    mov [es:di], al         ; Ghi ký tự ASCII
    mov byte [es:di+1], 07h ; Thuộc tính màu: Chữ trắng trên nền đen
    
    dec si           ; Lùi con trỏ chuỗi về trước
    add di, 2        ; Tiến con trỏ video lên (2 byte mỗi ký tự)
    loop reverse_print ; Lặp lại cho đến khi CX = 0

    hlt

; Dữ liệu
message db 'Hello 8086 Video Memory!', 0
