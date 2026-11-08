// queries/part3_indexes.js
// Частина 3 — індекси та оптимізація (explain до/після)
// Запуск: mongosh "ВАШ_URI" --file queries/part3_indexes.js
// Скрипт ідемпотентний: на початку видаляє всі індекси, крім _id, тож його можна запускати повторно.

db = db.getSiblingDB("spotify");

// ----------------------------------------------------------------------
// Допоміжна функція: витягує з explain("executionStats") ключові поля
// ----------------------------------------------------------------------
function summarize(label, exp) {
  const stages = [];
  const indexes = [];
  const bounds = [];

  // Рекурсивно обходимо дерево плану: SORT → FETCH → IXSCAN ...
  (function walk(node) {
    if (!node) return;
    stages.push(node.stage);
    if (node.indexName) indexes.push(node.indexName);
    if (node.indexBounds) bounds.push(node.indexBounds);
    if (node.inputStage) walk(node.inputStage);
    (node.inputStages || []).forEach(walk);
  })(exp.queryPlanner.winningPlan.queryPlan || exp.queryPlanner.winningPlan);

  const s = exp.executionStats;
  const result = {
    label: label,
    winningPlan: stages.join(" → "),
    indexName: indexes.length ? indexes.join(", ") : "(немає)",
    nReturned: s.nReturned,
    totalKeysExamined: s.totalKeysExamined,
    totalDocsExamined: s.totalDocsExamined,
    executionTimeMillis: s.executionTimeMillis,
    rejectedPlans: exp.queryPlanner.rejectedPlans.length
  };
  if (bounds.length) result.indexBounds = bounds[0];
  printjson(result);
  return result;
}

function header(title) {
  print("\n" + "=".repeat(70));
  print(title);
  print("=".repeat(70));
}

// Чистий старт — лишаємо тільки обов'язковий індекс _id_
db.tracks.dropIndexes();
print("Індекси на старті: " + JSON.stringify(db.tracks.getIndexes().map(i => i.name)));


// ======================================================================
// Завдання 1. Аналіз запиту та індексація
// ======================================================================
header("Завдання 1. track_genre = 'pop' + danceability ≥ 0.7, сортування за popularity ↓");

const q1Filter = { track_genre: "pop", "audio_features.danceability": { $gte: 0.7 } };
const q1Sort = { popularity: -1 };

// Сам запит з умови
const q1Result = db.tracks.find(q1Filter).sort(q1Sort).toArray();
print("Запит повертає документів: " + q1Result.length);

// 1.1. explain() БЕЗ індексів
print("\n--- 1.1. До створення індексу ---");
summarize("без індексу", db.tracks.find(q1Filter).sort(q1Sort).explain("executionStats"));

// 1.2. Створюємо індекс за правилом ESR: Equality → Sort → Range
//   track_genre                   — точний збіг (Equality)
//   popularity                    — поле сортування (Sort), напрям як у запиті
//   audio_features.danceability   — діапазон (Range)
db.tracks.createIndex(
  { track_genre: 1, popularity: -1, "audio_features.danceability": 1 },
  { name: "genre_popularity_danceability" }
);

print("\n--- 1.2. Після створення індексу (ESR) ---");
summarize("індекс ESR", db.tracks.find(q1Filter).sort(q1Sort).explain("executionStats"));

// 1.3. Для порівняння: «інтуїтивний» порядок Equality → Range → Sort
//   Фільтр обслуговується індексом, але сортування вже не може йти за індексом
db.tracks.createIndex(
  { track_genre: 1, "audio_features.danceability": 1, popularity: -1 },
  { name: "genre_danceability_popularity" }
);

print("\n--- 1.3. Порівняння: індекс E → R → S (примусово через hint) ---");
summarize("індекс ERS (hint)",
  db.tracks.find(q1Filter).sort(q1Sort).hint("genre_danceability_popularity").explain("executionStats"));

print("\n--- 1.4. Який план обирає оптимізатор, коли є обидва індекси ---");
summarize("вибір оптимізатора", db.tracks.find(q1Filter).sort(q1Sort).explain("executionStats"));

// Порівняльний індекс більше не потрібен — лишаємо тільки ESR
db.tracks.dropIndex("genre_danceability_popularity");


// ======================================================================
// Завдання 2. Індекс для пошуку музики для роботи
// ======================================================================
header("Завдання 2. explicit + instrumentalness + speechiness");

const q2Filter = {
  explicit: false,
  "audio_features.instrumentalness": { $gt: 0.5 },
  "audio_features.speechiness": { $lt: 0.1 }
};

print("\n--- 2.1. До створення індексу ---");
summarize("без індексу", db.tracks.find(q2Filter).explain("executionStats"));

// explicit — рівність (Equality) → першим;
// instrumentalness > 0.5 лишає ~17% документів, speechiness < 0.1 — ~80%,
// тому більш селективний діапазон ставимо раніше
db.tracks.createIndex(
  {
    explicit: 1,
    "audio_features.instrumentalness": 1,
    "audio_features.speechiness": 1
  },
  { name: "explicit_instrumentalness_speechiness" }
);

print("\n--- 2.2. Після створення індексу ---");
summarize("складений індекс", db.tracks.find(q2Filter).explain("executionStats"));

// Повний запит із частини 2 (завдання 4) — додатково з умовою на loudness.
// loudness не входить до індексу, тому ця умова перевіряється на стадії FETCH (поле filter).
const q2FullFilter = { ...q2Filter, "audio_features.loudness": { $lt: -10 } };
print("\n--- 2.3. Запит частини 2 (з loudness < -10) ---");
const exp23 = db.tracks.find(q2FullFilter).explain("executionStats");
summarize("складений індекс + loudness", exp23);
print("Фільтр на стадії FETCH: " +
  JSON.stringify(exp23.queryPlanner.winningPlan.queryPlan
    ? exp23.queryPlanner.winningPlan.queryPlan.filter
    : exp23.queryPlanner.winningPlan.filter));


// ======================================================================
// Завдання 3. Покривний запит (covered query) — факультативно
// ======================================================================
header("Завдання 3. Чи є запит покривним?");

const q3Filter = { track_genre: "pop", popularity: { $gte: 70 } };

print("\n--- 3.1. Запит з умови (без проєкції) ---");
summarize("без проєкції", db.tracks.find(q3Filter).explain("executionStats"));

print("\n--- 3.2. Той самий фільтр, але проєкція лише на поля індексу і _id: 0 ---");
summarize("з проєкцією",
  db.tracks.find(q3Filter, { _id: 0, track_genre: 1, popularity: 1 }).explain("executionStats"));

print("\n--- 3.3. Проєкція без _id: 0 (_id не входить до індексу) ---");
summarize("проєкція з _id",
  db.tracks.find(q3Filter, { track_genre: 1, popularity: 1 }).explain("executionStats"));


header("Підсумкові індекси колекції tracks");
printjson(db.tracks.getIndexes().map(i => ({ name: i.name, key: i.key })));
