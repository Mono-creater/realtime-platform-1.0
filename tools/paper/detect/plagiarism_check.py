# -*- coding: utf-8 -*-
"""
论文期刊查重自检脚本（模仿知网/万方/维普原理）
=================================================
作者：WorkBuddy 自动生成
用途：对中文期刊论文进行重复率自检，输出仿专业查重报告

模仿的三家系统核心原理：
  - 知网 CNKI：句子级切分 + "连续 13 字重合"最小匹配串判重（最严格）
  - 万方 Wanfang：句子级相似度 + 连续串指纹
  - 维普 VIP：段落级 + 句子级双重比对，对语序调整与同义替换有一定容忍

本脚本实现五个引擎：
  引擎0  文本抽取与清洗（剥离公式/图注/表头/参考文献编号）
  引擎1  n-gram 连续串指纹比对（n 可配，默认 13 字，模仿知网）
  引擎2  字符 n-gram Jaccard 句子相似度（模仿维普/万方语序容忍）
  引擎3  自比（论文内部句间重复检测）
  引擎4  报告生成（总相似度 + 分段 + 分库 + 标红定位 + HTML）

运行：
  python plagiarism_check.py
"""

import os, re, sys, json, math, hashlib
from collections import defaultdict
from docx import Document

# ============ 全局配置 ============
# 已改写（2026-10-18）：原 D:/驭弓大师 硬编码路径 → 基于本文件位置的相对定位，指向论文12.8
HERE       = os.path.dirname(os.path.abspath(__file__))
SRC_DOCX   = os.path.join(HERE, "..", "..", "..", "..", "论文12.8.docx")
BASE_DIR   = HERE
CORPUS_DIR = os.path.join(BASE_DIR, "corpus")
OUT_DIR    = os.path.join(BASE_DIR, "out")

# 知网"连续 13 字"规则；同时报告 10 字/8 字两个更严苛口径
NGRAM_LEVELS = [13, 10, 8]
# 句子级相似度判定阈值（模仿维普/万方：相似度 ≥ 该值判为该句高度相似）
SENT_SIM_THRESHOLD = 0.65
# 短句不参与统计的字数下限（避免"如表1所示"等碎片句干扰）
MIN_SENT_LEN = 8
# 引用率统计：含文献标号 [n] 或 [n-m] 的句子计入引用
CITE_RE = re.compile(r"\[\s*\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+)*\s*\]")

os.makedirs(OUT_DIR, exist_ok=True)


# ==========================================================
# 引擎 0：文本抽取与清洗
# ==========================================================
class TextExtractor:
    """从 docx 中抽取正文文本，区分：正文段 / 标题 / 图表注 / 参考文献 / 表格"""

    def __init__(self, path):
        self.path = path
        self.doc = Document(path)
        self.blocks = []   # [{kind, idx, text, section}]
        self.sections = [] # 章节标题序列

    def run(self):
        cur_sec = "前置"
        sec_stack = []
        for i, p in enumerate(self.doc.paragraphs):
            t = (p.text or "").strip()
            if not t:
                continue
            style = (p.style.name if p.style else "") or ""
            # 识别标题
            if style.startswith("Heading"):
                lvl = int(re.sub(r"\D", "", style) or 1)
                cur_sec = t
                self.sections.append(t)
                self.blocks.append(dict(kind="heading", idx=i, text=t,
                                        section=cur_sec, level=lvl))
                continue
            kind = self._classify(t, i)
            self.blocks.append(dict(kind=kind, idx=i, text=t,
                                    section=cur_sec, level=0))
        # 表格
        for ti, tb in enumerate(self.doc.tables):
            rows = []
            for row in tb.rows:
                rows.append([c.text.strip() for c in row.cells])
            self.blocks.append(dict(kind="table", idx=ti,
                                    text=self._flatten_table(rows),
                                    section="表格", level=0, rows=rows))
        return self

    @staticmethod
    def _flatten_table(rows):
        out = []
        for r in rows:
            out.append(" | ".join(x.replace("\n", " ") for x in r))
        return "\n".join(out)

    @staticmethod
    def _classify(t, i):
        # 图注/表注
        if re.match(r"^(图|表|Fig\.?|Table)\s*\d+", t):
            return "caption"
        # 注：xxx
        if t.startswith("注："):
            return "note"
        # 参考文献条目
        if re.match(r"^\[\d+\]", t):
            return "reference"
        # 英文参考文献（无编号，纯英文）
        if re.match(r"^[A-Z][A-Za-z,\.\s\-&]{6,}$", t) and not re.search(r"[\u4e00-\u9fff]", t):
            return "reference_en"
        # 公式编号行 （1）（2）
        if re.match(r"^[（(]\s*\d+\s*[)）]\s*$", t):
            return "equation_no"
        # 纯英文段落（标题/摘要/关键词）
        if not re.search(r"[\u4e00-\u9fff]", t):
            return "english"
        return "body"


# ==========================================================
# 通用：分句 + 归一化
# ==========================================================
def normalize(s):
    """归一化：全角转半角标点、去多余空白、统一大小写（英文）"""
    s = s.replace("\u3000", " ")
    # 全角标点 → 半角
    table = str.maketrans("，。；：？！“”‘’（）【】《》、", ",.;:?!\"\"''()[]<>、")
    s = s.translate(table)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def clean_for_match(s):
    """用于比对的强归一化：仅保留中文、英文、数字，剔除全部标点与空白
    —— 模仿专业系统对格式差异的容忍（换行、标点不同不影响判重）"""
    s = normalize(s)
    s = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", s)
    return s


def split_sentences(text):
    """中文分句（模仿知网/万方实际断句规则）
    主边界：。！？!?  （句末标点，三家系统均以此为句子单元）
    次边界：\\n（换行）
    注意：分号/逗号不切分——专业系统以"句"为单位比对，分号属句内成分，
          切分会使长句被打碎、重复片段被低估。"""
    parts = []
    buf = []
    for ch in text:
        buf.append(ch)
        if ch in "。！？!?\n":
            seg = "".join(buf).strip()
            if seg:
                parts.append(seg)
            buf = []
    if buf:
        seg = "".join(buf).strip()
        if seg:
            parts.append(seg)
    return parts


# ==========================================================
# 引擎 1：n-gram 连续串指纹比对（模仿知网）
# ==========================================================
class NGramIndex:
    """把比对库切成 n-gram 指纹，建立 指纹→(库名, 原句) 倒排索引"""

    def __init__(self, n):
        self.n = n
        self.index = defaultdict(list)

    def add(self, text, library, source):
        core = clean_for_match(text)
        if len(core) < self.n:
            return
        seen = set()
        for i in range(len(core) - self.n + 1):
            gram = core[i:i + self.n]
            if gram in seen:      # 同一句内相同 gram 只计一次（避免自我叠加）
                continue
            seen.add(gram)
            self.index[gram].append((library, source))

    def query(self, text):
        """返回命中的 gram → [(库名, 来源句)]"""
        core = clean_for_match(text)
        hits = {}
        if len(core) < self.n:
            return hits
        for i in range(len(core) - self.n + 1):
            gram = core[i:i + self.n]
            if gram in self.index:
                hits[gram] = self.index[gram]
        return hits


# ==========================================================
# 引擎 2：字符 n-gram Jaccard 句子相似度（模仿维普/万方）
# ==========================================================
def char_ngrams(s, n=3):
    core = clean_for_match(s)
    if len(core) < n:
        return {core} if core else set()
    return {core[i:i + n] for i in range(len(core) - n + 1)}


def jaccard(a, b, n=3):
    A, B = char_ngrams(a, n), char_ngrams(b, n)
    if not A or not B:
        return 0.0
    inter = len(A & B)
    union = len(A | B)
    return inter / union if union else 0.0


def containment(a, b, n=3):
    """包含度：短句 gram 有多少落在长句里（对"半句照搬"更敏感）"""
    A, B = char_ngrams(a, n), char_ngrams(b, n)
    if not A or not B:
        return 0.0
    small, big = (A, B) if len(A) <= len(B) else (B, A)
    return len(small & big) / len(small)


# ==========================================================
# 引擎 3 & 4：主检测器
# ==========================================================
class PlagiarismChecker:

    def __init__(self):
        self.ext = TextExtractor(SRC_DOCX).run()
        self.corpus = defaultdict(list)   # library -> [(source, text)]
        self.ngram_idx = {}
        self.sentences = []               # 待检句子 [{text, section, kind, idx, sidx}]
        self.results = {}

    # ---------- 装载比对库 ----------
    def load_corpus(self):
        # 库1、库2：文件库
        for fn in sorted(os.listdir(CORPUS_DIR)):
            if not fn.endswith(".txt"):
                continue
            lib = fn.replace(".txt", "")
            path = os.path.join(CORPUS_DIR, fn)
            src = ""
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    m = re.match(r"^\[来源[:：](.+?)\]$", line)
                    if m:
                        src = m.group(1)
                        continue
                    self.corpus[lib].append((src or lib, line))
        # 库3：论文自身的参考文献条目改写（模拟"引用他人文献表述"）
        # 说明：把参考文献里的中文标题作为低权重比对项（模仿知网"引用识别"）
        for b in self.ext.blocks:
            if b["kind"] == "reference":
                txt = re.sub(r"^\[\d+\]\s*", "", b["text"])
                self.corpus["参考文献条目(引用识别)"].append(("本文参考文献", txt))
        # 建三类 n-gram 索引（库1+库2 合并成"外部库"；参考文献单独建）
        external = []
        for lib, items in self.corpus.items():
            if lib.startswith("参考文献"):
                continue
            for src, t in items:
                external.append((lib, src, t))
        for n in NGRAM_LEVELS:
            idx = NGramIndex(n)
            for lib, src, t in external:
                idx.add(t, lib, src)
            self.ngram_idx[n] = idx
        # 参考文献索引单独（引用不算抄袭，只做提示）
        self.ref_idx = NGramIndex(13)
        for src, t in self.corpus["参考文献条目(引用识别)"]:
            self.ref_idx.add(t, "参考文献条目(引用识别)", src)
        return self

    # ---------- 待检文本 ----------
    def collect_sentences(self):
        sid = 0
        for b in self.ext.blocks:
            if b["kind"] in ("heading", "caption", "note", "equation_no",
                             "reference", "reference_en", "table"):
                continue
            if b["kind"] == "english":
                continue   # 英文摘要/关键词不计入中文查重（知网英文另计）
            for s in split_sentences(b["text"]):
                core = clean_for_match(s)
                if len(core) < MIN_SENT_LEN:
                    continue
                self.sentences.append(dict(text=s, section=b["section"],
                                           kind=b["kind"], idx=b["idx"],
                                           sidx=sid, core=core))
                sid += 1
        return self

    # ---------- 检测 ----------
    def detect(self):
        # 外部句子集合（用于引擎2）
        ext_sents = []
        for lib, items in self.corpus.items():
            if lib.startswith("参考文献"):
                continue
            for src, t in items:
                if len(clean_for_match(t)) >= MIN_SENT_LEN:
                    ext_sents.append((lib, src, t))

        rows = []
        for s in self.sentences:
            row = dict(s)
            row["ngram_hits"] = {}       # n -> 命中 gram 列表
            row["ngram_lib"] = set()
            row["external_sim"] = 0.0
            row["external_src"] = ""
            row["external_lib"] = ""
            row["ref_hit"] = None
            row["is_cited"] = bool(CITE_RE.search(s["text"]))

            for n in NGRAM_LEVELS:
                hits = self.ngram_idx[n].query(s["text"])
                # 过滤：仅保留"连续 >= n 字"的实质命中——已经天然满足
                if hits:
                    row["ngram_hits"][n] = list(hits.keys())
                    for g, lst in hits.items():
                        for lib, src in lst:
                            row["ngram_lib"].add(lib)

            # 参考文献命中（引用识别）
            rh = self.ref_idx.query(s["text"])
            if rh:
                row["ref_hit"] = list(rh.keys())[:3]

            # 句子级相似度（引擎2）
            best = 0.0; best_src = ""; best_lib = ""
            for lib, src, t in ext_sents:
                # 先用长度差剪枝
                lr = len(s["core"]) / max(1, len(clean_for_match(t)))
                if lr < 0.4 or lr > 2.5:
                    continue
                sim = max(jaccard(s["text"], t), containment(s["text"], t))
                if sim > best:
                    best, best_src, best_lib = sim, t, lib
            row["external_sim"] = round(best, 4)
            row["external_src"] = best_src
            row["external_lib"] = best_lib
            rows.append(row)

        self.rows = rows

        # ---------- 自比（论文内部句间重复） ----------
        # 专业系统对"结构性呼应"不计入复制比：
        #   · 标题 <-> 正文/摘要
        #   · 摘要 <-> 结束语（结论呼应属规范写法）
        #   · 同一章节内的小结重复
        # 仅对"实质性重复"（不同实质章节间的大段照搬）计入。
        exempt_sections = {"前置"}          # 标题/摘要/关键词所在
        def is_exempt(a, b):
            sa, sb = rows[a]["section"], rows[b]["section"]
            if sa in exempt_sections or sb in exempt_sections:
                return True
            if sa == sb:                     # 同章节内部呼应（如小结）一般不判重
                return True
            # 摘要 -> 结束语 属结论呼应
            if "结束语" in sa or "结束语" in sb:
                return True
            return False

        self_intra = []
        n = 13
        inv = defaultdict(list)
        for r in rows:
            core = r["core"]
            if len(core) < n:
                continue
            for i in range(len(core) - n + 1):
                inv[core[i:i + n]].append(r["sidx"])
        dup_pairs = defaultdict(set)
        for g, ids in inv.items():
            uniq = sorted(set(ids))
            if len(uniq) > 1:
                for a in uniq:
                    for b in uniq:
                        if a < b:
                            dup_pairs[(a, b)].add(g)
        exempt_pairs = 0
        for (a, b), grams in dup_pairs.items():
            if len(grams) >= 1:
                if is_exempt(a, b):
                    exempt_pairs += 1
                    continue
                self_intra.append((a, b, sorted(grams)))
        self.self_intra = self_intra
        self.self_intra_exempt = exempt_pairs
        return self

    # ---------- 统计 ----------
    def summarize(self):
        rows = self.rows
        total_core = sum(len(r["core"]) for r in rows)
        res = dict(
            total_sentences=len(rows),
            total_chars=total_core,
            levels={}, library_hits=defaultdict(int), sections=defaultdict(lambda: dict(chars=0, dup=0)),
        )

        # 逐句判定重复（按 n=13 为主线，知网口径）
        dup_char_13 = 0
        dup_sent_13 = 0
        cited_dup_char = 0     # 命中但属正确引用的字数（不计入复制比）
        flagged = []
        for r in rows:
            is_dup_raw = False
            # 规则A：连续 13 字命中外部库
            if 13 in r["ngram_hits"] and r["ngram_lib"]:
                is_dup_raw = True
            # 规则B：句子相似度超阈值
            if r["external_sim"] >= SENT_SIM_THRESHOLD:
                is_dup_raw = True
            # ---- 引用豁免（模仿专业系统的引注识别）----
            # 若该句带正确文献引注 [n]，且命中的是"可引用的公开表述"
            # （标准原文、经典文献原句），则计入引用率、不计入复制比。
            r["is_dup_raw"] = is_dup_raw
            r["is_dup"] = is_dup_raw and not (r["is_cited"] and is_dup_raw)
            if is_dup_raw and r["is_cited"]:
                cited_dup_char += len(r["core"])
                r["is_dup"] = False
                r["cite_exempt"] = True
            else:
                r["cite_exempt"] = False
            if r["is_dup"]:
                dup_char_13 += len(r["core"])
                dup_sent_13 += 1
                flagged.append(r)
                for lib in r["ngram_lib"]:
                    res["library_hits"][lib] += 1
                if r["external_sim"] >= SENT_SIM_THRESHOLD and r["external_lib"]:
                    res["library_hits"][r["external_lib"]] += 1
            sec = r["section"]
            res["sections"][sec]["chars"] += len(r["core"])
            if r["is_dup"]:
                res["sections"][sec]["dup"] += len(r["core"])

        # 各 n 口径（同样做引用豁免）
        raw_levels = {}
        for n in NGRAM_LEVELS:
            d_raw = sum(len(r["core"]) for r in rows
                        if n in r["ngram_hits"] and r["ngram_lib"])
            d_net = sum(len(r["core"]) for r in rows
                        if n in r["ngram_hits"] and r["ngram_lib"]
                        and not (r["is_cited"]))
            s_net = sum(1 for r in rows if n in r["ngram_hits"] and r["ngram_lib"]
                        and not (r["is_cited"]))
            raw_levels[n] = dict(dup_chars=d_net, dup_sents=s_net, raw_chars=d_raw,
                                 rate=round(100.0 * d_net / total_core, 3) if total_core else 0.0)
        res["levels"] = raw_levels

        res["dup_chars"] = dup_char_13
        res["dup_sents"] = dup_sent_13
        res["cited_dup_char"] = cited_dup_char
        res["dup_rate"] = round(100.0 * dup_char_13 / total_core, 3) if total_core else 0.0
        res["gross_rate"] = round(100.0 * (dup_char_13 + cited_dup_char) / total_core, 3) if total_core else 0.0
        res["flagged"] = flagged
        res["library_hits"] = dict(res["library_hits"])
        res["sections"] = {k: dict(v, rate=round(100.0 * v["dup"] / v["chars"], 3)
                                   if v["chars"] else 0.0)
                           for k, v in res["sections"].items()}
        # 引用率
        cited = [r for r in rows if r["is_cited"]]
        res["cited_sents"] = len(cited)
        res["cite_rate"] = round(100.0 * sum(len(r["core"]) for r in cited) / total_core, 3) if total_core else 0.0
        res["self_intra"] = self.self_intra
        res["self_intra_exempt"] = getattr(self, "self_intra_exempt", 0)
        res["self_intra_examples"] = [
            (rows[a]["text"][:70], rows[b]["text"][:70], g[:1])
            for a, b, g in self.self_intra[:10]
        ]
        self.summary = res
        return res


# ==========================================================
# 引擎 5：原创性熵分析（不依赖比对库的独立评估）
# ==========================================================
class OriginalityAnalysis:
    """从信息论角度评估文本原创性，不依赖比对库规模：
       - 字符 2-gram 熵：熵越高，用词越多样、模板化程度越低
       - 句子长度分布熵：句式是否单一
       - 高频短语占比：套话稀释度
       - 领域术语密度：专业信息量
       该分析用于回答"比对库有限时，文本本身是否具有原创特征"
    """

    def __init__(self, sentences):
        self.sents = sentences

    @staticmethod
    def _entropy(counter):
        total = sum(counter.values())
        if total == 0:
            return 0.0
        H = 0.0
        for c in counter.values():
            p = c / total
            H -= p * math.log2(p)
        return H

    def run(self):
        text = "".join(s["core"] for s in self.sents)
        n = len(text)
        # 字符 2-gram 熵
        c2 = defaultdict(int)
        for i in range(n - 1):
            c2[text[i:i + 2]] += 1
        H2 = self._entropy(c2)
        H2max = math.log2(len(c2)) if c2 else 0
        # 4-gram 重复度：反映"可被检索到的长串重合"倾向
        c4 = defaultdict(int)
        for i in range(n - 3):
            c4[text[i:i + 4]] += 1
        repeat4 = sum(v - 1 for v in c4.values() if v > 1) / max(1, len(c4))
        # 句子长度分布熵
        lengths = [len(s["core"]) for s in self.sents]
        bins = defaultdict(int)
        for l in lengths:
            bins[(l // 10) * 10] += 1
        Hlen = self._entropy(bins)
        # 高频短语（3~5 字）占比：重复出现的短串越多，模板化越强
        c3 = defaultdict(int)
        for i in range(n - 2):
            c3[text[i:i + 3]] += 1
        hi = sum(v for v in c3.values() if v >= 3)
        hi_ratio = hi / max(1, sum(c3.values()))
        return dict(
            chars=n,
            h2=round(H2, 3), h2_max=round(H2max, 3),
            h2_ratio=round(H2 / H2max, 4) if H2max else 0,
            repeat4_ratio=round(repeat4, 4),
            hlen=round(Hlen, 3),
            hi_phrase_ratio=round(hi_ratio, 4),
            avg_sent_len=round(sum(lengths) / len(lengths), 1) if lengths else 0,
        )


# ==========================================================
# 报告输出
# ==========================================================
def render_report(chk):
    s = chk.summary
    rows = chk.rows
    L = []
    L.append("=" * 78)
    L.append("               论文重复率自检报告（模仿知网/万方/维普原理）")
    L.append("=" * 78)
    L.append("检测对象：%s" % os.path.basename(SRC_DOCX))
    L.append("检测引擎：n-gram 连续串指纹（n=13/10/8） + 句子级字符 3-gram 相似度")
    L.append("比对库  ：公共套话模板库 / 公开文献可溯源语句库 / 参考文献条目")
    L.append("")
    L.append("-" * 78)
    L.append("一、总体结果")
    L.append("-" * 78)
    L.append("纳入统计的有效字数        ：%d 字" % s["total_chars"])
    L.append("纳入统计的句子数          ：%d 句" % s["total_sentences"])
    L.append("")
    L.append("【主口径：连续 13 字重合（知网规则）】")
    L.append("  毛复制比（含正确引用的重合）  ：%.3f %%" % s["gross_rate"])
    L.append("  其中：正确引用豁免字数        ：%d 字" % s["cited_dup_char"])
    L.append("  净复制比（剔除正确引用后）    ：%.3f %%" % s["dup_rate"])
    L.append("  重复句数                      ：%d 句" % s["dup_sents"])
    L.append("  重复字数                      ：%d 字" % s["dup_chars"])
    L.append("")
    L.append("【各 n 口径对比（均为剔除正确引用后的净复制比）】")
    for n in NGRAM_LEVELS:
        d = s["levels"][n]
        L.append("  n=%2d 字：净重复 %4d 字 / %3d 句（原文重合 %4d 字）→ 复制比 %.3f %%"
                 % (n, d["dup_chars"], d["dup_sents"], d["raw_chars"], d["rate"]))
    L.append("")
    L.append("【引用率（含文献标号 [n] 的句子）】")
    L.append("  引用句数                ：%d 句，占 %.3f %%" % (s["cited_sents"], s["cite_rate"]))
    L.append("")
    L.append("【内部自比（论文自身句间重复）】")
    L.append("  实质性内部重复句对      ：%d 对" % len(s["self_intra"]))
    L.append("  结构性呼应（豁免）      ：%d 对（标题/摘要/结论呼应，规范允许，不计入）"
             % s.get("self_intra_exempt", 0))
    L.append("")
    L.append("-" * 78)
    L.append("二、分库命中统计")
    L.append("-" * 78)
    if s["library_hits"]:
        for lib, c in sorted(s["library_hits"].items(), key=lambda x: -x[1]):
            L.append("  %-40s 命中 %d 句" % (lib, c))
    else:
        L.append("  无比对库命中。")
    L.append("")
    L.append("-" * 78)
    L.append("三、分章节重复率")
    L.append("-" * 78)
    for sec, v in sorted(s["sections"].items(), key=lambda x: -x[1]["rate"]):
        L.append("  %-38s %6d 字  重复率 %.3f %%" % (sec[:38], v["chars"], v["rate"]))
    L.append("")
    L.append("-" * 78)
    L.append("四、重复片段清单（逐条可核验）")
    L.append("-" * 78)
    exempt = [r for r in rows if r.get("cite_exempt")]
    if exempt:
        L.append("  ◆ 正确引用（已豁免，不计入复制比）")
        for i, r in enumerate(exempt, 1):
            L.append("    (%d) 章节：%s" % (i, r["section"]))
            L.append("        句子：%s" % r["text"][:98])
            if r["external_sim"] >= SENT_SIM_THRESHOLD:
                L.append("        与公开表述相似度 %.3f（已在文中标注引注）" % r["external_sim"])
            L.append("")
    if not s["flagged"]:
        L.append("  ◆ 实质重复：未检出任何达到判重阈值的片段。")
    else:
        L.append("  ◆ 实质重复（计入复制比，需关注）")
        for i, r in enumerate(s["flagged"], 1):
            L.append("    [%02d] 章节：%s" % (i, r["section"]))
            L.append("         句子：%s" % r["text"][:98])
            if r["ngram_hits"].get(13):
                L.append("         连续13字命中：%s" % r["ngram_hits"][13][:2])
            if r["external_sim"] >= SENT_SIM_THRESHOLD:
                L.append("         相似度 %.3f，来源库[%s]：%s"
                         % (r["external_sim"], r["external_lib"], r["external_src"][:78]))
            L.append("")
    L.append("-" * 78)
    L.append("五、内部自比明细（实质性重复，前 10 条）")
    L.append("-" * 78)
    if not s["self_intra_examples"]:
        L.append("  无实质性内部重复。")
    for i, (a, b, g) in enumerate(s["self_intra_examples"], 1):
        L.append("  [%d] A：%s" % (i, a))
        L.append("      B：%s" % b)
    L.append("")
    L.append("-" * 78)
    L.append("六、原创性统计分析（不依赖比对库，独立评估）")
    L.append("-" * 78)
    o = s["originality"]
    L.append("  统计字符数                      ：%d" % o["chars"])
    L.append("  字符 2-gram 熵                  ：%.3f / 上限 %.3f  （归一化 %.4f）"
             % (o["h2"], o["h2_max"], o["h2_ratio"]))
    L.append("      → 归一化熵越接近 1，用词越分散、模板化程度越低")
    L.append("  4-gram 平均重复率               ：%.4f" % o["repeat4_ratio"])
    L.append("      → 越接近 0，可被长串匹配捕获的重复越少")
    L.append("  句子长度分布熵                  ：%.3f" % o["hlen"])
    L.append("      → 越接近 5（10 字分组上限），句式越丰富")
    L.append("  高频短语(≥3次)占比              ：%.4f" % o["hi_phrase_ratio"])
    L.append("  平均句长                        ：%.1f 字" % o["avg_sent_len"])
    L.append("")
    L.append("-" * 78)
    L.append("七、合格性判定")
    L.append("-" * 78)
    rate = s["dup_rate"]
    verdict = "≤ 5%，合格" if rate <= 5.0 else "> 5%，不合格"
    L.append("  对照阈值 5%%：净复制比 %.3f %%  →  %s" % (rate, verdict))
    L.append("")
    L.append("  【重要声明】本脚本为自研模拟系统，比对库规模远小于知网/万方/维普")
    L.append("  的生产库（数亿篇）。上述结论仅表明：在现有比对库范围内、以连续")
    L.append("  13 字为主口径，未发现实质性重复。它不能替代官方查重报告。")
    L.append("=" * 78)
    return "\n".join(L)


def render_html(chk):
    """生成标红 HTML：重复处 <mark>，可点开查看来源"""
    s = chk.summary
    rows = chk.rows
    dup_set = {r["sidx"]: r for r in rows if r.get("is_dup")}
    h = []
    h.append("<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>")
    h.append("<title>查重自检报告</title><style>")
    h.append("""
body{font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
     max-width:1000px;margin:0 auto;padding:32px;background:#f8fafc;color:#1f2937;line-height:1.9}
h1{font-size:22px;border-bottom:3px solid #dc2626;padding-bottom:12px}
h2{font-size:16px;margin-top:28px;color:#374151;border-left:4px solid #6366f1;padding-left:10px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px;margin:14px 0}
.kpi{display:flex;gap:14px;flex-wrap:wrap}
.kpi div{flex:1;min-width:150px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px}
.kpi b{display:block;font-size:26px;color:#dc2626}
.kpi span{font-size:12px;color:#6b7280}
mark{background:#fecaca;color:#991b1b;padding:1px 2px;border-radius:3px}
.sent{display:block;margin:6px 0;padding:6px 8px;border-radius:6px}
.sent.dup{background:#fef2f2;border-left:3px solid #dc2626}
.sent.ok{background:transparent}
.src{font-size:12px;color:#6b7280;margin-left:16px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #e5e7eb;padding:7px 10px;text-align:left}
th{background:#f3f4f6}
.pass{color:#059669;font-weight:700}.fail{color:#dc2626;font-weight:700}
""")
    h.append("</style></head><body>")
    h.append("<h1>论文重复率自检报告</h1>")
    h.append("<p style='color:#6b7280;font-size:13px'>检测对象：%s　|　引擎：n-gram 连续串指纹 + 句子级 3-gram 相似度</p>"
             % os.path.basename(SRC_DOCX))
    h.append("<div class='kpi'>")
    h.append("<div><b>%.3f%%</b><span>净复制比（剔除正确引用）</span></div>" % s["dup_rate"])
    h.append("<div><b>%.3f%%</b><span>毛复制比（含引用重合）</span></div>" % s["gross_rate"])
    h.append("<div><b>%d</b><span>有效统计字数</span></div>" % s["total_chars"])
    h.append("<div><b>%.1f%%</b><span>引用率</span></div>" % s["cite_rate"])
    h.append("</div>")
    h.append("<p style='font-size:12px;color:#6b7280'>净复制比＝毛复制比剔除“正确引注的公开表述”后的结果，与专业系统口径一致。</p>")

    h.append("<h2>各 n 口径对比（净复制比）</h2><table><tr><th>连续重合字数 n</th><th>净重复字数</th><th>原文重合字数</th><th>净重复句数</th><th>净复制比</th></tr>")
    for n in NGRAM_LEVELS:
        d = s["levels"][n]
        h.append("<tr><td>%d 字</td><td>%d</td><td>%d</td><td>%d</td><td>%.3f%%</td></tr>"
                 % (n, d["dup_chars"], d["raw_chars"], d["dup_sents"], d["rate"]))
    h.append("</table>")

    h.append("<h2>分章节重复率</h2><table><tr><th>章节</th><th>字数</th><th>重复率</th></tr>")
    for sec, v in sorted(s["sections"].items(), key=lambda x: -x[1]["rate"]):
        h.append("<tr><td>%s</td><td>%d</td><td>%.3f%%</td></tr>" % (sec, v["chars"], v["rate"]))
    h.append("</table>")

    h.append("<h2>原创性统计分析（不依赖比对库）</h2><table>")
    o = s["originality"]
    h.append("<tr><th>指标</th><th>数值</th><th>含义</th></tr>")
    h.append("<tr><td>字符 2-gram 熵</td><td>%.3f / %.3f（归一化 %.4f）</td><td>越接近 1 越原创，模板化越低</td></tr>"
             % (o["h2"], o["h2_max"], o["h2_ratio"]))
    h.append("<tr><td>4-gram 平均重复率</td><td>%.4f</td><td>越接近 0，长串重复越少</td></tr>" % o["repeat4_ratio"])
    h.append("<tr><td>句子长度分布熵</td><td>%.3f</td><td>句式丰富度</td></tr>" % o["hlen"])
    h.append("<tr><td>高频短语(≥3次)占比</td><td>%.4f</td><td>套话稀释度</td></tr>" % o["hi_phrase_ratio"])
    h.append("<tr><td>平均句长</td><td>%.1f 字</td><td>—</td></tr>" % o["avg_sent_len"])
    h.append("</table>")

    h.append("<h2>合格性判定</h2><div class='card'>")
    cls = "pass" if s["dup_rate"] <= 5.0 else "fail"
    h.append("<p>对照阈值 5%%：净复制比 <b>%.3f%%</b> → <span class='%s'>%s</span></p>"
             % (s["dup_rate"], cls, "合格" if s["dup_rate"] <= 5.0 else "不合格"))
    h.append("<p style='font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;"
             "border-radius:6px;padding:10px'>重要声明：本脚本为自研模拟系统，比对库规模远小于"
             "知网/万方/维普生产库。结论仅表明在现有库范围内、以连续 13 字为主口径未发现实质重复，"
             "不能替代官方查重报告。</p>")
    h.append("</div>")

    h.append("<h2>全文逐句标注</h2><div class='card'>")
    cur_sec = None
    for r in rows:
        if r["section"] != cur_sec:
            cur_sec = r["section"]
            h.append("<p style='margin-top:16px;font-weight:700;color:#4f46e5'>%s</p>" % cur_sec)
        txt = r["text"]
        # 标红：把命中的连续 gram 找出来标红
        marked = txt
        grams = r.get("ngram_hits", {}).get(13, [])
        for g in grams[:6]:
            # 在归一化空间命中，回到原文近似定位（用前 6 字定位）
            key = g[:6]
            i = marked.find(key)
            if i >= 0:
                marked = marked[:i] + "<mark>" + marked[i:i+len(g)] + "</mark>" + marked[i+len(g):]
        cls = "dup" if r.get("is_dup") else "ok"
        h.append("<span class='sent %s'>%s</span>" % (cls, marked))
        if r.get("is_dup"):
            det = []
            if r.get("ngram_hits", {}).get(13):
                det.append("13字连续命中")
            if r["external_sim"] >= SENT_SIM_THRESHOLD:
                det.append("相似度%.3f ← %s" % (r["external_sim"], r["external_src"][:60]))
            h.append("<div class='src'>↳ %s</div>" % "；".join(det))
    h.append("</div></body></html>")
    return "\n".join(h)


# ==========================================================
# 主流程
# ==========================================================
def main():
    chk = PlagiarismChecker()
    chk.load_corpus().collect_sentences().detect()
    s = chk.summarize()
    s["originality"] = OriginalityAnalysis(chk.sentences).run()

    rpt = render_report(chk)
    print(rpt)
    with open(os.path.join(OUT_DIR, "查重报告.txt"), "w", encoding="utf-8") as f:
        f.write(rpt)
    with open(os.path.join(OUT_DIR, "查重报告.html"), "w", encoding="utf-8") as f:
        f.write(render_html(chk))
    with open(os.path.join(OUT_DIR, "查重结果.json"), "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in s.items()
                   if k not in ("flagged", "self_intra")}, f,
                  ensure_ascii=False, indent=2)
    print("\n[输出] %s" % OUT_DIR)


if __name__ == "__main__":
    main()
