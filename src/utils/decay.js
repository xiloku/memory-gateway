function calculateDecayScore(memory) {
  const now = Date.now();
  const lastAccessed = new Date(memory.last_accessed_at).getTime();
  const hoursSince = (now - lastAccessed) / (1000 * 60 * 60);
  const daysSince = hoursSince / 24;
  
  // 新鲜度
  const freshness = 1.0 + 1.0 * Math.exp(-hoursSince / 36);
  
  // 时间权重
  const timeWeight = freshness;
  
  // 情感权重
  const arousal = memory.arousal || 0.5;
  const emotionWeight = 1.0 + arousal * 0.8;
  
  // 短期/长期合并
  let combinedWeight;
  if (daysSince <= 3) {
    combinedWeight = timeWeight * 0.7 + emotionWeight * 0.3;
  } else {
    combinedWeight = emotionWeight * 0.7 + timeWeight * 0.3;
  }
  
  // 修正因子
  let resolvedFactor;
  if (memory.is_resolved && memory.is_digested) {
    resolvedFactor = 0.02;
  } else if (memory.is_resolved) {
    resolvedFactor = 0.05;
  } else {
    resolvedFactor = 1.0;
  }
  
  // 紧急加成
  let urgencyBoost = 1.0;
  if (!memory.is_resolved && arousal > 0.7) {
    urgencyBoost = 1.5;
  }
  
  // 最终分数
  const importance = memory.importance || 5.0;
  const accessCount = memory.access_count || 0;
  
  const finalScore = importance 
    * Math.pow(accessCount + 1, 0.3) 
    * Math.exp(-0.05 * daysSince) 
    * combinedWeight 
    * resolvedFactor 
    * urgencyBoost;
  
  return finalScore;
}

module.exports = { calculateDecayScore };
