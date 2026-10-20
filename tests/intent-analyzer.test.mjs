import assert from "node:assert/strict";
import test from "node:test";
import { analyzeIntent } from "../dist/services/intent-analyzer.js";

test("clear offers are classified as unverified selling only for unverified authors", () => {
  assert.equal(analyzeIntent("Ofrezco sexting y videollamadas").intent, "UNVERIFIED_SELLING");
  assert.equal(analyzeIntent("Soy escort, escríbeme").intent, "UNVERIFIED_SELLING");
  assert.equal(analyzeIntent("Ofrezco sexting y videollamadas", true).intent, "NEUTRAL");
});

test("buyers and ordinary adult conversation are not classified as selling", () => {
  for (const text of [
    "¿Quién ofrece videollamadas?",
    "Me gustan tus tetas",
    "Está buena",
    "Quiero comprar un pack",
  ]) {
    assert.notEqual(analyzeIntent(text).intent, "UNVERIFIED_SELLING", text);
  }
  assert.equal(analyzeIntent("¿Quién ofrece videollamadas?").intent, "BUYER_INTEREST");
  assert.equal(analyzeIntent("Me gustan tus tetas").intent, "BUYER_INTEREST");
});

test("illegal content requires both explicit illegal context and an operational request or offer", () => {
  for (const text of [
    "Vendo pornografia infantil",
    "Busco videos de abuso sexual infantil",
    "Pásame material de explotación sexual de menores",
    "Busco videos de violación",
    "Vendo CP de menores",
  ]) {
    assert.equal(analyzeIntent(text).intent, "ILLEGAL_VIOLATION", text);
  }
  for (const text of [
    "Denuncio la pornografía infantil",
    "La violación es un delito",
    "CP",
    "Vi una noticia sobre grooming",
  ]) {
    assert.notEqual(analyzeIntent(text).intent, "ILLEGAL_VIOLATION", text);
  }
});
