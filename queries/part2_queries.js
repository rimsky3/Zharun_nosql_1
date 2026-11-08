// queries/part2_queries.js
// Частина 2 — запити до колекції spotify.tracks
// Запуск: mongosh "ВАШ_URI" --file queries/part2_queries.js
 
db = db.getSiblingDB("spotify");
 
function header(title) {
  print("\n" + "=".repeat(70));
  print(title);
  print("=".repeat(70));
}
 
 
// ======================================================================
// Завдання 1. Треки для вечірки
// danceability > 0.7, energy > 0.7, тривалість 3–5 хв (180000–300000 мс)
// ======================================================================
header("Завдання 1. Треки для вечірки");
 
const partyFilter = {
  "audio_features.danceability": { $gt: 0.7 },        // вкладене поле — через крапку в лапках
  "audio_features.energy": { $gt: 0.7 },
  duration_ms: { $gte: 180000, $lte: 300000 }          // діапазон: обидві межі включно
};
 
const partyProjection = {
  _id: 0,
  track_name: 1,
  artists: 1,
  track_genre: 1,
  popularity: 1,
  duration_sec: 1,
  "audio_features.danceability": 1,
  "audio_features.energy": 1
};
 
// Повний запит (усі треки, найпопулярніші першими)
const partyTracks = db.tracks.find(partyFilter, partyProjection).sort({ popularity: -1, track_name: 1, track_genre: 1 });
 
print("Знайдено документів: " + db.tracks.countDocuments(partyFilter));
print("Унікальних треків (без дублікатів track_id між жанрами): " +
  db.tracks.distinct("track_id", partyFilter).length);
print("Топ-10 за популярністю:");
printjson(partyTracks.limit(10).toArray());
 
 
// ======================================================================
// Завдання 2. Виконавці, у яких усі треки популярні
// ≥ 3 треки і мінімальна популярність ≥ 60 → топ-20 за середньою популярністю
// ======================================================================
header("Завдання 2. Виконавці, у яких усі треки популярні");
 
const popularArtists = db.tracks.aggregate([
  // 1) Дедуплікація: той самий трек (track_id) у датасеті повторюється в кількох жанрах.
  //    Без цього кроку один трек рахувався б як 2–4 «різні» треки артиста.
  //    $min — консервативний вибір для тих 720 дублікатів, у яких популярність різниться на 1–2 пункти.
  {
    $group: {
      _id: "$track_id",
      artists: { $first: "$artists" },        // масив виконавців однаковий для всіх копій
      popularity: { $min: "$popularity" }
    }
  },
 
  // 2) Розгортаємо масив: трек з 2 виконавцями → 2 документи, по одному на кожного
  { $unwind: "$artists" },
 
  // 3) Статистика по кожному виконавцю
  {
    $group: {
      _id: "$artists",
      track_count: { $sum: 1 },
      min_popularity: { $min: "$popularity" },
      avg_popularity: { $avg: "$popularity" }
    }
  },
 
  // 4) Умова «популярного» артиста
  { $match: { track_count: { $gte: 3 }, min_popularity: { $gte: 60 } } },
 
  // 5) Топ-20: за середньою популярністю, при рівності — у кого більше треків, потім за ім'ям
  { $sort: { avg_popularity: -1, track_count: -1, _id: 1 } },
  { $limit: 20 },
 
  // 6) Гарний вивід
  {
    $project: {
      _id: 0,
      artist: "$_id",
      track_count: "$track_count",   // явний вираз, щоб поле йшло після artist
      min_popularity: { $round: ["$min_popularity", 1] },
      avg_popularity: { $round: ["$avg_popularity", 1] }
    }
  }
]).toArray();
 
print("Топ-20 артистів:");
printjson(popularArtists);
 
 
// ======================================================================
// Завдання 3. Нетипові треки: tempo > avg жанру + 2 * stdDevPop жанру
// ======================================================================
header("Завдання 3. Нетипові (надшвидкі) треки за жанрами");
 
const tempoOutliers = db.tracks.aggregate([
  // 1) Статистика по кожному жанру + збираємо легкі копії треків цього жанру
  {
    $group: {
      _id: "$track_genre",
      avg_tempo: { $avg: "$audio_features.tempo" },
      std_tempo: { $stdDevPop: "$audio_features.tempo" },
      tracks: {
        $push: {
          _id: "$_id",
          track_name: "$track_name",
          popularity: "$popularity",
          artists: "$artists",
          audio_features: { tempo: "$audio_features.tempo" }
        }
      }
    }
  },
 
  // 2) Поріг нетиповості: mean + 2σ
  {
    $addFields: {
      outlier_threshold: { $add: ["$avg_tempo", { $multiply: [2, "$std_tempo"] }] }
    }
  },
 
  // 3) Лишаємо в масиві лише треки, темп яких перевищує поріг (порівнюємо з неокругленим порогом)
  {
    $addFields: {
      outlier_tracks: {
        $sortArray: {
          input: {
            $filter: {
              input: "$tracks",
              as: "t",
              cond: { $gt: ["$$t.audio_features.tempo", "$outlier_threshold"] }
            }
          },
          sortBy: { "audio_features.tempo": -1 }   // найшвидші першими
        }
      }
    }
  },
 
  // 4) Жанри, де нетипових треків немає, у звіт не потрапляють
  { $match: { "outlier_tracks.0": { $exists: true } } },
 
  // 5) Формат результату як у завданні
  {
    $project: {
      _id: 0,
      avg_tempo: { $round: ["$avg_tempo", 1] },
      genre: "$_id",
      outlier_threshold: { $round: ["$outlier_threshold", 1] },
      outlier_tracks: 1
    }
  },
  { $sort: { genre: 1 } }
]).toArray();
 
print("Жанрів із нетиповими треками: " + tempoOutliers.length);
print("Усього нетипових треків: " +
  tempoOutliers.reduce((sum, g) => sum + g.outlier_tracks.length, 0));
print("Приклад (жанр acoustic, перші 3 треки):");
const acoustic = tempoOutliers.find(g => g.genre === "acoustic");
printjson({ ...acoustic, outlier_tracks: acoustic.outlier_tracks.slice(0, 3) });
print("Кількість нетипових треків по жанрах (перші 10):");
printjson(tempoOutliers.slice(0, 10).map(g => ({
  genre: g.genre,
  avg_tempo: g.avg_tempo,
  outlier_threshold: g.outlier_threshold,
  outliers: g.outlier_tracks.length
})));
 
 
// ======================================================================
// Завдання 4. Треки для фонової роботи
// тихі (loudness < -10), мало мовлення (speechiness < 0.1),
// інструментальні (instrumentalness > 0.5), без explicit
// ======================================================================
header("Завдання 4. Треки для фонової роботи");
 
const workFilter = {
  "audio_features.loudness": { $lt: -10 },             // дБ, від'ємні значення: -10 гучніше, ніж -20
  "audio_features.speechiness": { $lt: 0.1 },
  "audio_features.instrumentalness": { $gt: 0.5 },
  explicit: false
};
 
const workTracks = db.tracks.find(workFilter, {
    _id: 0,
    track_name: 1,
    artists: 1,
    track_genre: 1,
    popularity: 1,
    "audio_features.loudness": 1,
    "audio_features.speechiness": 1,
    "audio_features.instrumentalness": 1
  }).sort({ popularity: -1, track_name: 1, track_genre: 1 });
 
print("Знайдено документів: " + db.tracks.countDocuments(workFilter));
print("Унікальних треків: " + db.tracks.distinct("track_id", workFilter).length);
print("Топ-10 за популярністю:");
printjson(workTracks.limit(10).toArray());
print("Найчастіші жанри серед результатів:");
printjson(db.tracks.aggregate([
  { $match: workFilter },
  { $group: { _id: "$track_genre", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 5 }
]).toArray());