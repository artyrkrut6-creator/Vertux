// src/logic/vortexService.js

// Жесткая ссылка на локальный сервер, который мы только что проверили через curl
const API_URL = "http://localhost:5176/api/predict";

export const getVortexPrediction = async (currentCandles) => {
  // Берем последнюю известную точку
  const lastCandle = currentCandles[currentCandles.length - 1];
  const lastTime = lastCandle.time;

  // Берем последние 50 цен закрытия
  const historyData = currentCandles.slice(-50).map(c => c.close);

  console.log("📡 Sending request to Real AI Server...");

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ historyData }),
    });

    if (!response.ok) {
      throw new Error(`Server Error: ${response.status}`);
    }

    const data = await response.json();
    console.log("✅ AI Response received:", data);

    // Если нейросеть вернула бред (103, 104) при цене 60000, 
    // масштабируем это (временный фикс), чтобы график не ломался
    let prices = data.prediction;
    if (prices && prices.length > 0 && prices[0] < lastCandle.close * 0.1) {
        console.warn("⚠️ AI returned unscaled data, fixing scale...");
        // Просто для визуализации, пока не поправим промпт
        prices = prices.map(p => lastCandle.close + (p * 10)); 
    }

    // Формируем данные для графика
    const chartData = (prices || []).map((price, i) => ({
      time: lastTime + (i + 1) * 60, // +1 минута для каждой точки
      value: price
    }));

    return { data: chartData, source: data.source };

  } catch (error) {
    console.error("❌ Connection failed:", error);
    return { data: [], source: 'error' };
  }
};
