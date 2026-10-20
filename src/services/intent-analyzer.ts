export type MessageIntent =
  | "ILLEGAL_VIOLATION"
  | "UNVERIFIED_SELLING"
  | "BUYER_INTEREST"
  | "NEUTRAL";

export interface IntentAnalysis {
  intent: MessageIntent;
  reason: string;
}

const ADULT_SERVICE_TERMS =
  /\b(?:culo|tetas?|senos?|vagina|escort|escorts|sexting|videollamadas?|novia virtual|packs?|catalogos?|fotos?|videos?|contenido adulto|servicios sexuales)\b/u;
const ILLEGAL_CONTENT_TERMS =
  /\b(?:pornografia infantil|porno infantil|abuso sexual infantil|abuso infantil|material de abuso infantil|explotacion sexual (?:de )?menores|pornografia de menores|sexo con menores|grooming|zoofilia|bestialidad|sexo con animales|violacion)\b/u;
const CONTEXTUAL_CP_TERM =
  /\bcp\b.{0,32}\b(?:menores?|infantil|ninos?|ninas?)\b|\b(?:menores?|infantil|ninos?|ninas?)\b.{0,32}\bcp\b/u;
const ILLEGAL_DISTRIBUTION_INTENT =
  /\b(?:vendo|vender|venta|compro|comprar|busco|buscando|consigo|conseguir|intercambio|intercambiar|compart[eo]|envia(?:me)?|manda(?:me)?|pasa(?:me)?|descarga|link|enlace|archivo|fotos?|videos?|material|contenido|pack|packs)\b/u;
const SELF_SELLING_INTENT =
  /\b(?:(?:yo\s+)?(?:vendo|ofrezco|hago|realizo|acepto|preparo|atiendo|promociono)|soy\s+(?:escort|novia virtual)|trabajo como\s+(?:escort|novia virtual)|mis?\s+(?:packs?|fotos?|videos?|servicios?)\s+(?:estan|están)\s+(?:disponibles|a la venta)|(?:disponible|available)\s+(?:para|por)\s+(?:sexting|videollamadas?))\b/u;
const BUYER_INTEREST_INTENT =
  /\b(?:quiero|quisiera|busco|buscando|me interesa|me gustaria|me gust\w*|me encantan?|alguien|quien|donde|compro|comprar|tienen|hay|busco a alguien)\b/u;

function normalize(value: string): string {
  return value
    .slice(0, 4096)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, "")
    .replace(/<\/?[a-z][^>]*>/giu, "")
    .replace(/(?:```|`{1,2}|\*{1,2}|~{2}|\|{2})/gu, "")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function analyzeIntent(
  input: string,
  verified = false,
): IntentAnalysis {
  const text = normalize(input);
  if (!text) return { intent: "NEUTRAL", reason: "empty_message" };

  if (
    (ILLEGAL_CONTENT_TERMS.test(text) || CONTEXTUAL_CP_TERM.test(text)) &&
    ILLEGAL_DISTRIBUTION_INTENT.test(text)
  ) {
    return {
      intent: "ILLEGAL_VIOLATION",
      reason: "explicit_illegal_content_distribution_or_request",
    };
  }

  if (
    !verified &&
    ADULT_SERVICE_TERMS.test(text) &&
    SELF_SELLING_INTENT.test(text)
  ) {
    return {
      intent: "UNVERIFIED_SELLING",
      reason: "clear_author_offer_of_adult_service",
    };
  }

  if (
    ADULT_SERVICE_TERMS.test(text) &&
    BUYER_INTEREST_INTENT.test(text)
  ) {
    return {
      intent: "BUYER_INTEREST",
      reason: "buyer_or_neutral_interest_in_adult_service",
    };
  }

  return { intent: "NEUTRAL", reason: "no_clear_intent" };
}
