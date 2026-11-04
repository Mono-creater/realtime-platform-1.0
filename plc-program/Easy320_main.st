(************************************************************
 * Easy320_main.st —— 汇川 Easy320 传感器采集 + Modbus 组包参考程序
 * 语言: ST（AutoShop 编译下载）  目标: 文档级参考代码
 *
 * 功能: 100ms 采样温度/压力/湿度(4-20mA) → 10 条滑窗均值
 *       → 阈值判异常 → 主包(全部数据) + 子包(异常数据)
 *       → 状态字/序号 → 读回写寄存器驱动比例阀/升弓机构
 *
 * 机型: 汇川 Easy320（Easy 系列紧凑型网络主机，双网口，AutoShop 编程）
 * ⚠️ D 区 ↔ Modbus 映射（AutoShop MBS 服务: 4xN ↔ DN 直接对应）
 *    本程序用 D2001-D2022。Easy320 属 Easy 系列，D 区从 D0 起编址，
 *    没有 D30001 段（该段只存在于 D 区容量 ≥32767 的大容量机型）。
 *    平台 .env 默认值已与之一致（协议地址 = 这里选定的 4x 地址）：
 *        PLC_REG_TEMP=2001  PLC_REG_PRESS=2002  PLC_REG_HUMID=2003
 *        PLC_REG_STATUS=2004  PLC_REG_SEQ=2005
 *        PLC_REG_SUB_BASE=2011  PLC_REG_WRITE_FORCE=2021  PLC_REG_WRITE_HEIGHT=2022
 *    仅在换用 D 区 ≥32767 的大容量机型时，才把 D2001-2022 整体替换为
 *    D30001-30022 段，并同步把平台 .env 的 PLC_REG_* 改到 30001 起。
 *
 * 寄存器语义（协议原地址 = 4x + 本程序 D 编号）：
 *   D2001     温度均值 ×10（有符号 16 位，负数用补码）
 *   D2002     压力均值 ×10（0.1kPa，勿用 ×100：1000kPa→100000 超 uint16）
 *   D2003     湿度均值 ×10
 *   D2004     状态字 bit0/1/2=温/压/湿异常；bit6=0x40 扩展协议标志(恒置)；
 *             bit7=0x80 子包有效
 *   D2005     主包序号（65535→1 回绕，0 保留给旧固件）
 *   D2011     子包序号（= 异常发生时主包序号）
 *   D2012     异常位图（bit0-2 同状态字）
 *   D2013-15  子包异常值（温度/压力/湿度，缩放同上，仅对应位有效）
 *   D2021     接触力环输出 = 气囊压力设定 ×10 kPa   [平台 FC16 写入]
 *   D2022     姿态环输出   = 弓头高度设定 mm         [平台 FC16 写入]
 ************************************************************)

VAR
    (* ---- 采样与滑窗 ---- *)
    lastClock   : BOOL;                     (* 100ms 脉冲上升沿检测 *)
    sampleIdx   : INT := 0;                 (* 当前滑窗位置 0-9 *)
    fifoT       : ARRAY[0..9] OF REAL;      (* 温度滑窗 FIFO *)
    fifoP       : ARRAY[0..9] OF REAL;      (* 压力滑窗 FIFO *)
    fifoH       : ARRAY[0..9] OF REAL;      (* 湿度滑窗 FIFO *)
    sumT, sumP, sumH : REAL;                (* 滑窗求和 *)
    avgT, avgP, avgH : REAL;                (* 10 条均值 *)
    i           : INT;                      (* 循环变量 *)

    (* ---- 阈值判定 ---- *)
    abnormal    : INT := 0;                 (* 异常位图 0=正常 bit0温 bit1压 bit2湿 *)
    statusWord  : INT := 0;                 (* D2004 状态字组装用 *)

    (* ---- 模拟量原始值（请替换为实际 AD 通道元件）---- *)
    aiTemp      : REAL;                     (* 温度通道原始值 *)
    aiPress     : REAL;                     (* 压力通道原始值 *)
    aiHumid     : REAL;                     (* 湿度通道原始值 *)

    (* ---- 模拟量量程（GL10-4AD: 4mA/20mA 对应原始值，按实际模块校准）---- *)
    raw4mA      : REAL := 8000.0;
    raw20mA     : REAL := 40000.0;
    rawSpan     : REAL := 32000.0;          (* raw20mA - raw4mA *)

    (* ---- 写回读值 ---- *)
    pressSet    : REAL;                     (* 来自 D2021 的压力设定 kPa *)
    heightSet   : REAL;                     (* 来自 D2022 的高度设定 mm *)
END_VAR

(* ============================================================
 * 主流程：每 100ms 执行一次（AutoShop 的 100ms 脉冲继电器 SM4010；
 * Easy320 沿用同一套特殊软元件编号，若你的机型手册中该位不同，请替换）
 * ============================================================ *)
IF SM4010 AND NOT lastClock THEN

    (* ---------- 1. 4-20mA → 工程量换算（量程按实际传感器标定修改） ----------
       温度: 4-20mA 对应 -10 ~ 80°C
       压力: 4-20mA 对应   0 ~ 1000kPa
       湿度: 4-20mA 对应   0 ~ 100%RH                            *)
    aiTemp  := (温度通道元件 - raw4mA) / rawSpan * 90.0 - 10.0;
    aiPress := (压力通道元件 - raw4mA) / rawSpan * 1000.0;
    aiHumid := (湿度通道元件 - raw4mA) / rawSpan * 100.0;

    (* ---------- 2. 滑窗 FIFO：新样本覆盖最旧的一条 ---------- *)
    fifoT[sampleIdx] := aiTemp;
    fifoP[sampleIdx] := aiPress;
    fifoH[sampleIdx] := aiHumid;
    sampleIdx := sampleIdx + 1;

    (* ---------- 3. 每满 10 条（1s）计算均值 + 判阈 + 组包 ---------- *)
    IF sampleIdx >= 10 THEN
        sampleIdx := 0;
        sumT := 0.0; sumP := 0.0; sumH := 0.0;
        FOR i := 0 TO 9 DO
            sumT := sumT + fifoT[i];
            sumP := sumP + fifoP[i];
            sumH := sumH + fifoH[i];
        END_FOR;
        avgT := sumT / 10.0;
        avgP := sumP / 10.0;
        avgH := sumH / 10.0;

        (* ---------- 4. 阈值判定（与平台 THRESHOLDS 保持一致） ---------- *)
        abnormal := 0;
        IF avgT > 80.0 OR avgT < -10.0 THEN abnormal := abnormal OR 1;   END_IF;
        IF avgP > 1000.0 OR avgP < 100.0 THEN abnormal := abnormal OR 2; END_IF;
        IF avgH > 85.0 THEN abnormal := abnormal OR 4;                   END_IF;

        (* ---------- 5. 主包写入（全部数据） ----------
           REAL→定点：四舍五入到 0.1 精度；温度负值补码处理         *)
        D2001 := REAL_TO_INT(avgT * 10.0);                  (* 温度 ×10 *)
        IF avgT < 0.0 THEN D2001 := D2001 + 65536; END_IF;  (* 负数补码 *)
        D2002 := REAL_TO_INT(avgP * 10.0);                  (* 压力 ×10 *)
        D2003 := REAL_TO_INT(avgH * 10.0);                  (* 湿度 ×10 *)

        (* ---------- 6. 序号：65535→1 回绕（0 保留给旧固件判定） ---------- *)
        D2005 := D2005 + 1;
        IF D2005 > 65535 THEN D2005 := 1; END_IF;

        (* ---------- 7. 状态字：bit6 恒置扩展协议标志；异常时置对应位 ---------- *)
        statusWord := 16#40;                               (* bit6 恒置 *)
        IF abnormal <> 0 THEN
            statusWord := statusWord OR abnormal;          (* bit0-2 异常位 *)
            statusWord := statusWord OR 16#80;             (* bit7 子包有效 *)

            (* ---------- 8. 子包：序号=主包序号，位图+异常值 ---------- *)
            D2011 := D2005;
            D2012 := abnormal;
            D2013 := D2001;                                (* 异常值 = 本周期均值 *)
            D2014 := D2002;
            D2015 := D2003;
        END_IF;
        D2004 := statusWord;

        (* ---------- 9. 读回平台写寄存器，驱动执行机构 ----------
           D2021 压力设定(×10 kPa) → 比例阀模拟量输出
           D2022 高度设定(mm)     → 升弓机构模拟量输出
           （量程换算按实际执行机构标定修改）                     *)
        pressSet  := D2021 / 10.0;                         (* kPa *)
        heightSet := D2022;                                (* mm *)
        比例阀输出元件 := REAL_TO_INT((pressSet  / 1000.0) * rawSpan + raw4mA);
        升弓机构输出元件 := REAL_TO_INT((heightSet / 2600.0) * rawSpan + raw4mA);
    END_IF;
END_IF;

lastClock := SM4010;

(* 程序结束。下载到 PLC 前请务必：
   1) 替换"温度通道元件/压力通道元件/湿度通道元件/比例阀输出元件/升弓机构输出元件"
      为实际软元件；
   2) 在 MBS 服务配置中启用从站（端口 502）并确认 4xN ↔ DN 映射；
   3) 用 ModbusPoll 读 4x2001-2005 核对数值与状态字（bit6=0x40）；
   4) 平台 .env 按本文件头部的映射表设置 REG_* 变量。 *)
