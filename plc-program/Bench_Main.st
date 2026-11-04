VAR
lastClock : BOOL;
sampleIdx : INT;
bufT0 : REAL;
bufT1 : REAL;
bufT2 : REAL;
bufT3 : REAL;
bufT4 : REAL;
bufT5 : REAL;
bufT6 : REAL;
bufT7 : REAL;
bufT8 : REAL;
bufT9 : REAL;
bufP0 : REAL;
bufP1 : REAL;
bufP2 : REAL;
bufP3 : REAL;
bufP4 : REAL;
bufP5 : REAL;
bufP6 : REAL;
bufP7 : REAL;
bufP8 : REAL;
bufP9 : REAL;
bufH0 : REAL;
bufH1 : REAL;
bufH2 : REAL;
bufH3 : REAL;
bufH4 : REAL;
bufH5 : REAL;
bufH6 : REAL;
bufH7 : REAL;
bufH8 : REAL;
bufH9 : REAL;
fifoSumT : REAL;
fifoSumP : REAL;
fifoSumH : REAL;
fifoAvgT : REAL;
fifoAvgP : REAL;
fifoAvgH : REAL;
abnormal : INT;
statusWord : INT;
aiTemp : REAL;
aiPress : REAL;
aiHumid : REAL;
raw4mA : REAL;
raw20mA : REAL;
rawSpan : REAL;
pressSet : REAL;
heightSet : REAL;
localMode : BOOL;
runFlag : BOOL;
x0Last : BOOL;
cycleStep : INT;
cycleCount : INT;
tickCnt : INT;
baseH : INT;
topH : INT;
upTicks : INT;
holdTicks : INT;
maxCycles : INT;
yUp : BOOL;
yDown : BOOL;
END_VAR

(************************************************************
 * Bench_Main.st —— 台架实测主程序（LiteST 兼容版）
 * 机型：汇川 Easy320（AutoShop，结构化文本 LiteST）
 *
 * ⚠️ 本版按 LiteST 限制改写：
 *   · 不用 ARRAY，不用 Arr[n] 下标（LiteST 不支持变量下标）
 *   · 不用 FOR 循环
 *   · 10 点滑窗改成 30 个标量移位寄存器（bufT0..bufT9 / bufP0..bufP9 / bufH0..bufH9）
 *
 * 功能：
 *   ① 协议：100 ms 采样、10 点均值、1 s 组包、状态字、序号、子包
 *   ② 本地循环：X0 启动、X1 停止、X2 常闭急停；20 s 升 / 60 s 顶保 /
 *      20 s 降 / 60 s 底保，30 次自动停；X3 选本地/远程
 *   ③ 安全：Y0/Y1 互锁；急停保持位置不降弓；D2022 钳位 50~1450
 *
 * 模式：
 *   X3 = 0  远程：D2021/D2022 由平台 FC16 写入
 *   X3 = 1  本地：PLC 自己写 D2022，按 100→1400→100 循环
 *
 * 寄存器：D2001 温度×10  D2002 压力×10  D2003 湿度×10
 *         D2004 状态字  D2005 序号  D2011-15 子包
 *         D2021 压力设定×10kPa  D2022 高度设定 mm
 *
 * 下载前替换 5 个软元件（按实际模块地址核对）：
 *   温度 D500  压力 D501  湿度 D502  比例阀 D510  升弓 D511（模块到位后换回 AIW/AQW）
 ************************************************************)



(* ============================================================
 * 每 100 ms 执行一次（M8012 上升沿）
 * ============================================================ *)
IF M8012 AND NOT lastClock THEN

    (* 常量每周期赋值，避免依赖变量初值 *)
    raw4mA := 8000.0;
    raw20mA := 40000.0;
    rawSpan := 32000.0;
    baseH := 100;
    topH := 1400;
    upTicks := 200;
    holdTicks := 600;
    maxCycles := 30;

    (* ---------- 1. 4~20 mA → 工程量 ---------- *)
    aiTemp  := (D500 - raw4mA) / rawSpan * 90.0 - 10.0;
    aiPress := (D501 - raw4mA) / rawSpan * 1000.0;
    aiHumid := (D502 - raw4mA) / rawSpan * 100.0;

    (* ---------- 2. 移位寄存器：新值进 bufT0，旧值后移 ---------- *)
    bufT9 := bufT8; bufT8 := bufT7; bufT7 := bufT6; bufT6 := bufT5; bufT5 := bufT4;
    bufT4 := bufT3; bufT3 := bufT2; bufT2 := bufT1; bufT1 := bufT0; bufT0 := aiTemp;

    bufP9 := bufP8; bufP8 := bufP7; bufP7 := bufP6; bufP6 := bufP5; bufP5 := bufP4;
    bufP4 := bufP3; bufP3 := bufP2; bufP2 := bufP1; bufP1 := bufP0; bufP0 := aiPress;

    bufH9 := bufH8; bufH8 := bufH7; bufH7 := bufH6; bufH6 := bufH5; bufH5 := bufH4;
    bufH4 := bufH3; bufH3 := bufH2; bufH2 := bufH1; bufH1 := bufH0; bufH0 := aiHumid;

    (* ---------- 3. 每 10 个采样（1 s）组包 ---------- *)
    sampleIdx := sampleIdx + 1;
    IF sampleIdx >= 10 THEN
        sampleIdx := 0;

        fifoSumT := bufT0+bufT1+bufT2+bufT3+bufT4+bufT5+bufT6+bufT7+bufT8+bufT9;
        fifoSumP := bufP0+bufP1+bufP2+bufP3+bufP4+bufP5+bufP6+bufP7+bufP8+bufP9;
        fifoSumH := bufH0+bufH1+bufH2+bufH3+bufH4+bufH5+bufH6+bufH7+bufH8+bufH9;
        fifoAvgT := fifoSumT / 10.0;
        fifoAvgP := fifoSumP / 10.0;
        fifoAvgH := fifoSumH / 10.0;

        (* ---------- 4. 阈值判定 ---------- *)
        abnormal := 0;
        IF fifoAvgT > 80.0 OR fifoAvgT < -10.0 THEN abnormal := abnormal OR 1;   END_IF;
        IF fifoAvgP > 1000.0 OR fifoAvgP < 100.0 THEN abnormal := abnormal OR 2; END_IF;
        IF fifoAvgH > 85.0 THEN abnormal := abnormal OR 4;                   END_IF;

        (* ---------- 5. 主包 ---------- *)
        D2001 := REAL_TO_INT(fifoAvgT * 10.0);
        IF fifoAvgT < 0.0 THEN D2001 := D2001 + 65536; END_IF;
        D2002 := REAL_TO_INT(fifoAvgP * 10.0);
        D2003 := REAL_TO_INT(fifoAvgH * 10.0);

        (* ---------- 6. 序号回绕 ---------- *)
        D2005 := D2005 + 1;
        IF D2005 > 65535 THEN D2005 := 1; END_IF;

        (* ---------- 7. 状态字 + 子包 ---------- *)
        statusWord := 16#40;
        IF abnormal <> 0 THEN
            statusWord := statusWord OR abnormal;
            statusWord := statusWord OR 16#80;
            D2011 := D2005;
            D2012 := abnormal;
            D2013 := D2001;
            D2014 := D2002;
            D2015 := D2003;
        END_IF;
        D2004 := statusWord;
    END_IF;

    (* ---------- 8. 设定值安全钳位 ---------- *)
    IF D2022 < 50 THEN D2022 := 50; END_IF;
    IF D2022 > 1450 THEN D2022 := 1450; END_IF;
    IF D2021 < 0 THEN D2021 := 0; END_IF;
    IF D2021 > 10000 THEN D2021 := 10000; END_IF;

    (* ---------- 9. 本地循环（X3=1） ---------- *)
    localMode := X3;
    IF NOT localMode THEN
        runFlag := FALSE;
        cycleStep := 0;
        tickCnt := 0;
        yUp := FALSE;
        yDown := FALSE;
    ELSE
        (* 急停/停止：X2 常闭（正常=1，按下=0）；X1 常开（按下=1） *)
        IF (NOT X2) OR X1 THEN
            runFlag := FALSE;
            cycleStep := 0;
            tickCnt := 0;
            yUp := FALSE;
            yDown := FALSE;
        END_IF;

        (* 启动：X0 上升沿 *)
        IF X0 AND NOT x0Last THEN
            runFlag := TRUE;
            cycleCount := 0;
            cycleStep := 1;
            tickCnt := 0;
        END_IF;

        IF runFlag THEN
            tickCnt := tickCnt + 1;
            IF cycleStep = 1 THEN
                yUp := TRUE; yDown := FALSE; D2022 := topH;
                IF tickCnt >= upTicks THEN
                    cycleStep := 2; tickCnt := 0; yUp := FALSE;
                END_IF;
            ELSIF cycleStep = 2 THEN
                yUp := FALSE; yDown := FALSE; D2022 := topH;
                IF tickCnt >= holdTicks THEN
                    cycleStep := 3; tickCnt := 0;
                END_IF;
            ELSIF cycleStep = 3 THEN
                yUp := FALSE; yDown := TRUE; D2022 := baseH;
                IF tickCnt >= upTicks THEN
                    cycleStep := 4; tickCnt := 0; yDown := FALSE;
                END_IF;
            ELSIF cycleStep = 4 THEN
                yUp := FALSE; yDown := FALSE; D2022 := baseH;
                IF tickCnt >= holdTicks THEN
                    cycleCount := cycleCount + 1;
                    tickCnt := 0;
                    IF cycleCount >= maxCycles THEN
                        runFlag := FALSE;
                        cycleStep := 0;
                        D2022 := baseH;
                    ELSE
                        cycleStep := 1;
                    END_IF;
                END_IF;
            END_IF;
        END_IF;
        (* 急停/停止保持当前位置，不主动降弓 *)
    END_IF;

    (* X0 边沿记忆每周期更新 *)
    x0Last := X0;

    (* ---------- 10. 输出互锁 ---------- *)
    IF yUp AND yDown THEN
        yUp := FALSE;
        yDown := FALSE;
    END_IF;
    Y0 := yUp;
    Y1 := yDown;

    (* ---------- 11. AO 输出（按全行程 1500 mm 标定） ---------- *)
    pressSet  := D2021 / 10.0;
    heightSet := D2022;
    D510   := REAL_TO_INT((pressSet  / 1000.0) * rawSpan + raw4mA);
    D511 := REAL_TO_INT((heightSet / 1500.0) * rawSpan + raw4mA);

END_IF;

lastClock := M8012;

(* 下载前检查：
   1) 5 个软元件替换为实际地址；
   2) MBS 从站 502、unit 1，4xN ↔ DN 映射；
   3) X3=0 远程 / X3=1 本地；X2 必须接常闭急停。 *)
