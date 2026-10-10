/* 王国争覇：自己対戦で調整した「強い」の終盤しきい値（tools/train.js が書き換えます） */
(function (root) { var W = { strong: { provAt: 16, hakuryoAt: 4, shoryoAt: 2, hakuryoLate: 5, ratio: 11, ppr: 1 } }; if (typeof module !== 'undefined' && module.exports) module.exports = W; else root.KS_WEIGHTS = W; })(this);
