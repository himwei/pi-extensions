import assert from "node:assert/strict";
import { planEdits } from "./matcher.js";

const edit = (source: string, oldText: string, newText: string) =>
  planEdits(source, [{ oldText, newText }], "case.txt");

assert.equal(edit("Ａ A", "A", "B").content, "Ａ B", "unique exact match must not count Unicode lookalikes");
assert.throws(() => edit("x x", "x", "z"), /Ambiguous/);
assert.throws(() => edit("aaa", "aa", "z"), /Ambiguous/, "overlapping occurrences count as ambiguity");
assert.equal(edit("x\nx \n", "x\n", "z\n").content, "z\nx \n", "exact matching wins over a whitespace-normalized duplicate");
assert.equal(edit("x\r\nx\n", "x\r\n", "z\n").content, "z\r\nx\n", "literal CRLF wins over a newline-normalized duplicate");
assert.equal(edit("x\r\nx\n", "x\n", "z\n").content, "x\r\nz\r\n", "literal LF wins over a newline-normalized duplicate");
assert.throws(() => edit("x\r\nx\r\nx\n", "x\r\n", "z"), /Ambiguous/);
assert.throws(() => edit("Ａ", "A", "B"), /No match/);
assert.throws(() => edit("“x”", '"x"', '"y"'), /No match/);
assert.throws(() => edit("x—y", "x-y", "z"), /No match/);
assert.throws(() => edit("x\n  y", "x\n    y", "z"), /No match/, "indentation is literal");
assert.equal(edit("a\r\nb\nc", "a\nb", "x\ny").content, "x\r\ny\nc", "inserted LF follows first file newline, untouched LF remains");
assert.equal(edit("a \r\nb", "\nb", "\nc").content, "a \r\nc", "a leading LF matches the complete CRLF and preserves preceding whitespace");
assert.equal(edit("a\t\r\nb", " \nb", "\nc").content, "a\r\nc", "explicit leading whitespace before a newline belongs to the span");
assert.equal(edit("\uFEFFa\r\nb", "a", "z").content, "\uFEFFz\r\nb");
assert.throws(() => edit("a\r\n", "\uFEFFa\n", "z"), /No match/, "BOM is not a tolerated difference");
assert.equal(edit("a😀 b", "😀", "界").content, "a界 b", "indices are original UTF-16 spans");
assert.equal(edit("const s = 'Ａ'; x=1 \t\r\nnext\t\n", "x=1\n", "x=2\n").content,
  "const s = 'Ａ'; x=2\r\nnext\t\n", "fuzzy matching must not rewrite unrelated text on the same line");
assert.equal(edit("left \t\nright", "left\nright", "done").usedWhitespaceMatch, true);
assert.equal(edit("left\t", "left ", "done ").content, "done ", "explicit trailing whitespace is inside the replaced span");
assert.throws(() => edit("leftover", "left ", "done"), /No match/, "trailing whitespace tolerance cannot drop whitespace in the middle of a source line");
assert.equal(edit("left\t\nright", "left \nright", "done").content, "done");
assert.equal(edit("left \r\nright\t", "left\nright", "done").content, "done\t", "unmatched final whitespace stays outside the replaced span");
assert.throws(() => edit("left\t\nright\nleft \nright", "left\nright", "z"), /Ambiguous/);
assert.equal(planEdits("aa bb cc", [
  { oldText: "aa", newText: "bb" }, { oldText: "bb", newText: "dd" },
], "case.txt").content, "bb dd cc", "all matches refer to the original");
assert.throws(() => planEdits("abcdef", [
  { oldText: "abc", newText: "x" }, { oldText: "bcde", newText: "y" },
], "case.txt"), /Overlapping/);
assert.throws(() => planEdits("aa bb", [
  { oldText: "aa", newText: "aa" }, { oldText: "bb", newText: "cc" },
], "case.txt"), /No changes/, "a no-op block is rejected even when another block changes content");
assert.throws(() => edit("abc", "", "x"), /non-empty/);
assert.throws(() => planEdits("abc", [], "case.txt"), /at least one/);
assert.throws(() => edit("abc", " \t", "x"), /No match/);
assert.equal(edit("one  \r\ntwo\t\nthree", "one", "ONE").content, "ONE  \r\ntwo\t\nthree");
assert.equal(edit("a\rb", "a\rb", "x").content, "x", "bare CR is literal, not a normalized newline");

console.log("write-transforms matcher tests passed");
