/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/txoracle.json`.
 */
export type Txoracle = {
  "address": "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
  "metadata": {
    "name": "txoracle",
    "version": "1.5.5",
    "spec": "0.1.0",
    "description": "TxODDS TxLINE Data system"
  },
  "instructions": [
    {
      "name": "closePricingMatrix",
      "discriminator": [
        251,
        118,
        215,
        117,
        22,
        155,
        38,
        73
      ],
      "accounts": [
        {
          "name": "pricingMatrix",
          "writable": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": []
    },
    {
      "name": "initializePricingMatrix",
      "discriminator": [
        147,
        32,
        167,
        248,
        235,
        57,
        210,
        6
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "pricingMatrix",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "rows",
          "type": {
            "vec": {
              "defined": {
                "name": "serviceRow"
              }
            }
          }
        }
      ]
    },
    {
      "name": "initializeTreasuryV2",
      "discriminator": [
        18,
        140,
        152,
        210,
        31,
        25,
        22,
        171
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenTreasuryVault",
          "writable": true
        },
        {
          "name": "tokenTreasuryPda"
        },
        {
          "name": "subscriptionTokenMint"
        },
        {
          "name": "systemProgram"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "initializeUsdtTreasury",
      "discriminator": [
        81,
        0,
        86,
        241,
        86,
        85,
        243,
        74
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "usdtTreasuryVault",
          "writable": true
        },
        {
          "name": "usdtTreasuryPda"
        },
        {
          "name": "usdtMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram"
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": []
    },
    {
      "name": "insertBatchRoot",
      "discriminator": [
        243,
        170,
        208,
        158,
        207,
        29,
        237,
        93
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "dailyBatchRoots",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "epochDay",
          "type": "u16"
        },
        {
          "name": "hourOfDay",
          "type": "u8"
        },
        {
          "name": "minuteOfHour",
          "type": "u8"
        },
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "accountBump",
          "type": "u8"
        }
      ]
    },
    {
      "name": "insertFixturesRoot",
      "discriminator": [
        18,
        70,
        8,
        160,
        75,
        200,
        109,
        235
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "tenDailyFixturesRoots",
          "docs": [
            "The address is constrained by the seeds, and we verify the",
            "discriminator and owner inside the instruction."
          ],
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "epochDay",
          "type": "u16"
        },
        {
          "name": "index",
          "type": "u64"
        },
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "insertScoresRoot",
      "discriminator": [
        137,
        39,
        242,
        97,
        131,
        204,
        100,
        133
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "dailyScoresRoots",
          "docs": [
            "The address is constrained by the seeds, and we verify the",
            "discriminator and owner inside the instruction."
          ],
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "epochDay",
          "type": "u16"
        },
        {
          "name": "hourOfDay",
          "type": "u8"
        },
        {
          "name": "minuteOfHour",
          "type": "u8"
        },
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "purchaseSubscriptionTokenUsdt",
      "discriminator": [
        198,
        251,
        223,
        9,
        31,
        184,
        166,
        188
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "backendAdmin",
          "docs": [
            "Require backend server authority to cosign to authorize the purchase"
          ],
          "signer": true
        },
        {
          "name": "usdtMint"
        },
        {
          "name": "buyerUsdtAccount",
          "writable": true
        },
        {
          "name": "usdtTreasuryVault",
          "writable": true
        },
        {
          "name": "usdtTreasuryPda"
        },
        {
          "name": "subscriptionTokenMint"
        },
        {
          "name": "tokenTreasuryVault",
          "writable": true
        },
        {
          "name": "tokenTreasuryPda"
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "token2022Program"
        },
        {
          "name": "systemProgram"
        },
        {
          "name": "associatedTokenProgram"
        }
      ],
      "args": [
        {
          "name": "txlineAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "subscribe",
      "discriminator": [
        254,
        28,
        191,
        138,
        156,
        179,
        183,
        53
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "pricingMatrix"
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "userTokenAccount",
          "writable": true
        },
        {
          "name": "tokenTreasuryVault",
          "writable": true
        },
        {
          "name": "tokenTreasuryPda",
          "docs": [
            "Hold the PDA that owns the vault"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram"
        },
        {
          "name": "associatedTokenProgram"
        }
      ],
      "args": [
        {
          "name": "serviceLevelId",
          "type": "u16"
        },
        {
          "name": "weeks",
          "type": "u8"
        }
      ]
    },
    {
      "name": "updatePricingMatrix",
      "discriminator": [
        177,
        191,
        172,
        252,
        42,
        203,
        8,
        164
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "pricingMatrix",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "rows",
          "type": {
            "vec": {
              "defined": {
                "name": "serviceRow"
              }
            }
          }
        }
      ]
    },
    {
      "name": "validateFixture",
      "discriminator": [
        231,
        129,
        218,
        86,
        223,
        114,
        21,
        126
      ],
      "accounts": [
        {
          "name": "tenDailyFixturesRoots",
          "docs": [
            "Constrain the address by seeds to ensure the correct PDA is loaded"
          ]
        }
      ],
      "args": [
        {
          "name": "snapshot",
          "type": {
            "defined": {
              "name": "fixture"
            }
          }
        },
        {
          "name": "summary",
          "type": {
            "defined": {
              "name": "fixtureBatchSummary"
            }
          }
        },
        {
          "name": "subTreeProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        },
        {
          "name": "mainTreeProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        }
      ],
      "returns": "bool"
    },
    {
      "name": "validateFixtureBatch",
      "discriminator": [
        85,
        223,
        204,
        7,
        4,
        87,
        157,
        1
      ],
      "accounts": [
        {
          "name": "tenDailyFixturesRoots",
          "docs": [
            "Constrain the address by seeds to ensure the correct PDA is loaded"
          ]
        }
      ],
      "args": [
        {
          "name": "index",
          "type": "u8"
        },
        {
          "name": "metadata",
          "type": {
            "defined": {
              "name": "batchMetadata"
            }
          }
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        }
      ],
      "returns": "bool"
    },
    {
      "name": "validateOdds",
      "discriminator": [
        192,
        19,
        91,
        138,
        104,
        100,
        212,
        86
      ],
      "accounts": [
        {
          "name": "dailyOddsMerkleRoots"
        }
      ],
      "args": [
        {
          "name": "ts",
          "type": "i64"
        },
        {
          "name": "oddsSnapshot",
          "type": {
            "defined": {
              "name": "odds"
            }
          }
        },
        {
          "name": "summary",
          "type": {
            "defined": {
              "name": "oddsBatchSummary"
            }
          }
        },
        {
          "name": "subTreeProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        },
        {
          "name": "mainTreeProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        }
      ],
      "returns": "bool"
    },
    {
      "name": "validateStat",
      "discriminator": [
        107,
        197,
        232,
        90,
        191,
        136,
        105,
        185
      ],
      "accounts": [
        {
          "name": "dailyScoresMerkleRoots"
        }
      ],
      "args": [
        {
          "name": "ts",
          "type": "i64"
        },
        {
          "name": "fixtureSummary",
          "type": {
            "defined": {
              "name": "scoresBatchSummary"
            }
          }
        },
        {
          "name": "fixtureProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        },
        {
          "name": "mainTreeProof",
          "type": {
            "vec": {
              "defined": {
                "name": "proofNode"
              }
            }
          }
        },
        {
          "name": "predicate",
          "type": {
            "defined": {
              "name": "traderPredicate"
            }
          }
        },
        {
          "name": "statA",
          "type": {
            "defined": {
              "name": "statTerm"
            }
          }
        },
        {
          "name": "statB",
          "type": {
            "option": {
              "defined": {
                "name": "statTerm"
              }
            }
          }
        },
        {
          "name": "op",
          "type": {
            "option": {
              "defined": {
                "name": "binaryExpression"
              }
            }
          }
        }
      ],
      "returns": "bool"
    },
    {
      "name": "validateStatV2",
      "discriminator": [
        208,
        215,
        194,
        214,
        241,
        71,
        246,
        178
      ],
      "accounts": [
        {
          "name": "dailyScoresMerkleRoots"
        }
      ],
      "args": [
        {
          "name": "payload",
          "type": {
            "defined": {
              "name": "statValidationInput"
            }
          }
        },
        {
          "name": "strategy",
          "type": {
            "defined": {
              "name": "nDimensionalStrategy"
            }
          }
        }
      ],
      "returns": "bool"
    },
    {
      "name": "withdrawUsdt",
      "discriminator": [
        117,
        75,
        94,
        162,
        178,
        92,
        19,
        141
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "adminDestination",
          "writable": true
        },
        {
          "name": "usdtTreasuryVault",
          "writable": true
        },
        {
          "name": "usdtTreasuryPda"
        },
        {
          "name": "usdtMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram"
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "pricingMatrix",
      "discriminator": [
        173,
        13,
        64,
        22,
        248,
        77,
        110,
        106
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "eventNotActive",
      "msg": "Event is not active"
    },
    {
      "code": 6001,
      "name": "pricesMismatch",
      "msg": "Prices and price names arrays must be the same length"
    },
    {
      "code": 6002,
      "name": "invalidOddsUpdate",
      "msg": "Invalid odds update for this event"
    },
    {
      "code": 6003,
      "name": "invalidSubTreeProof",
      "msg": "Invalid sub-tree proof. The snapshot does not belong to the summary."
    },
    {
      "code": 6004,
      "name": "invalidMainTreeProof",
      "msg": "Invalid main tree proof. The summary does not belong to the on-chain root."
    },
    {
      "code": 6005,
      "name": "timeSlotMismatch",
      "msg": "Time slot mismatch between snapshot and on-chain root account."
    },
    {
      "code": 6006,
      "name": "invalidTime",
      "msg": "The provided hour or minute is out of the valid range."
    },
    {
      "code": 6007,
      "name": "rootNotAvailable",
      "msg": "Merkle root for this time slot has not been posted by the oracle."
    },
    {
      "code": 6008,
      "name": "accountDiscriminatorMismatch",
      "msg": "Mismatched account discriminator."
    },
    {
      "code": 6009,
      "name": "invalidPda",
      "msg": "The provided daily root account does not match the expected PDA."
    },
    {
      "code": 6010,
      "name": "timestampMismatch",
      "msg": "The timestamp provided for seed generation does not match the timestamp in the snapshot payload."
    },
    {
      "code": 6011,
      "name": "sliceError",
      "msg": "Could not slice the account data correctly."
    },
    {
      "code": 6012,
      "name": "invalidOwner",
      "msg": "Invalid account owner."
    },
    {
      "code": 6013,
      "name": "invalidTimeSlot",
      "msg": "Invalid time slot, must be aligned on a 5-min boundary."
    },
    {
      "code": 6014,
      "name": "stakeStillLocked",
      "msg": "Stake is still locked and cannot be withdrawn yet."
    },
    {
      "code": 6015,
      "name": "invalidRecipient",
      "msg": "Invalid recipient of the financial transaction."
    },
    {
      "code": 6016,
      "name": "activeSubscription",
      "msg": "You already have an active subscription."
    },
    {
      "code": 6017,
      "name": "unauthorized",
      "msg": "Unauthorized account updater."
    },
    {
      "code": 6018,
      "name": "invalidAccountOwner",
      "msg": "Invalid account owner."
    },
    {
      "code": 6019,
      "name": "invalidMintAuthority",
      "msg": "Invalid mint authority."
    },
    {
      "code": 6020,
      "name": "invalidMint",
      "msg": "Invalid mint."
    },
    {
      "code": 6021,
      "name": "predicateFailed",
      "msg": "Predicate failed."
    },
    {
      "code": 6022,
      "name": "invalidFixtureSubTreeProof",
      "msg": "Invalid sub-tree proof for fixture"
    },
    {
      "code": 6023,
      "name": "invalidStatProof",
      "msg": "Invalid stats proof for event"
    },
    {
      "code": 6024,
      "name": "invalidStatCombination",
      "msg": "invalid stat combination"
    },
    {
      "code": 6025,
      "name": "missingSecondStat",
      "msg": "Missing second stat"
    },
    {
      "code": 6026,
      "name": "unexpectedSecondStat",
      "msg": "Unexpected second stat"
    },
    {
      "code": 6027,
      "name": "overflow",
      "msg": "overflow"
    },
    {
      "code": 6028,
      "name": "tradeNotActive",
      "msg": "Trade not active"
    },
    {
      "code": 6029,
      "name": "invalidTrader",
      "msg": "Invalid trader"
    },
    {
      "code": 6030,
      "name": "winnerMismatch",
      "msg": "Winner mismatch"
    },
    {
      "code": 6031,
      "name": "tradeTermsMismatch",
      "msg": "Trade terms mismatch"
    },
    {
      "code": 6032,
      "name": "unauthorizedSettler",
      "msg": "Unauthorized settler"
    },
    {
      "code": 6033,
      "name": "fundsBelowMinimumDeposit",
      "msg": "Funds below minimal deposit amount"
    },
    {
      "code": 6034,
      "name": "insufficientUserBalance",
      "msg": "Insufficient token balance"
    },
    {
      "code": 6035,
      "name": "zeroAmount",
      "msg": "Cannot withdraw zero amount"
    },
    {
      "code": 6036,
      "name": "vaultNotEmpty",
      "msg": "Vault not empty"
    },
    {
      "code": 6037,
      "name": "insufficientVaultBalance",
      "msg": "Insufficient vault balance"
    },
    {
      "code": 6038,
      "name": "calculationError",
      "msg": "Calculation error"
    },
    {
      "code": 6039,
      "name": "invalidSubscriptionTs",
      "msg": "Subscription end Ts invalid"
    },
    {
      "code": 6040,
      "name": "cannotShortenSubscription",
      "msg": "Cannot shorten an existing subscription"
    },
    {
      "code": 6041,
      "name": "invalidWeeks",
      "msg": "Weeks must be a multiple of 4"
    },
    {
      "code": 6042,
      "name": "invalidTimeAlignment",
      "msg": "Invalid time alignment"
    },
    {
      "code": 6043,
      "name": "invalidEpochDayAlignment",
      "msg": "Invalid epoch day alignment"
    },
    {
      "code": 6044,
      "name": "accountDataTooSmall",
      "msg": "Account data too small"
    },
    {
      "code": 6045,
      "name": "insufficientLiquidity",
      "msg": "Insufficient liquidity"
    },
    {
      "code": 6046,
      "name": "invalidAmount",
      "msg": "Invalid amount"
    },
    {
      "code": 6047,
      "name": "invalidExpiration",
      "msg": "Invalid expiration"
    },
    {
      "code": 6048,
      "name": "fixtureMismatch",
      "msg": "Fixture mismatch"
    },
    {
      "code": 6049,
      "name": "periodMismatch",
      "msg": "Period mismatch"
    },
    {
      "code": 6050,
      "name": "intentNotActive",
      "msg": "Intent not active"
    },
    {
      "code": 6051,
      "name": "orderNotYetExpired",
      "msg": "Order not yet expired"
    },
    {
      "code": 6052,
      "name": "termsMismatch",
      "msg": "Terms mismatch"
    },
    {
      "code": 6053,
      "name": "statKeyMismatch",
      "msg": "Stat key mismatch"
    },
    {
      "code": 6054,
      "name": "invalidVault",
      "msg": "Invalid vault"
    },
    {
      "code": 6055,
      "name": "equivocationAttempt",
      "msg": "Equivocation attempt"
    },
    {
      "code": 6056,
      "name": "numericOverflow",
      "msg": "Numeric overflow"
    },
    {
      "code": 6057,
      "name": "invalidAccountData",
      "msg": "Invalid account data"
    },
    {
      "code": 6058,
      "name": "rateLimitExceeded",
      "msg": "Rate limit exceeded"
    },
    {
      "code": 6059,
      "name": "invalidServiceLevelId",
      "msg": "Invalid service level Id"
    },
    {
      "code": 6060,
      "name": "initialRowsLimitExceeded",
      "msg": "Initial rows limit exceeded"
    },
    {
      "code": 6061,
      "name": "missingStat",
      "msg": "Missing stat"
    },
    {
      "code": 6062,
      "name": "proofTooLarge",
      "msg": "Proof too large"
    },
    {
      "code": 6063,
      "name": "tradeTooSmall",
      "msg": "Trade too small"
    },
    {
      "code": 6064,
      "name": "maxRowsLimitExceeded",
      "msg": "Max rows limit exceeded"
    },
    {
      "code": 6065,
      "name": "unauthorizedAdmin",
      "msg": "Unauthorized admin"
    },
    {
      "code": 6066,
      "name": "invalidAccount",
      "msg": "invalid account"
    },
    {
      "code": 6067,
      "name": "missingSummary",
      "msg": "Missing summary"
    },
    {
      "code": 6068,
      "name": "missingProof",
      "msg": "Missing proof"
    },
    {
      "code": 6069,
      "name": "tooManyStats",
      "msg": "Stat index exceeds maximum allowed limit"
    },
    {
      "code": 6070,
      "name": "duplicateStatCoverage",
      "msg": "Stat index is evaluated multiple times"
    },
    {
      "code": 6071,
      "name": "incompleteStatCoverage",
      "msg": "Not all extracted stats were evaluated"
    },
    {
      "code": 6072,
      "name": "missingDistancePredicate",
      "msg": "Distance predicate is missing for geometric targets"
    },
    {
      "code": 6073,
      "name": "indexOutOfBounds",
      "msg": "Index out of bounds"
    },
    {
      "code": 6074,
      "name": "statNotZero",
      "msg": "Stat not zero"
    }
  ],
  "types": [
    {
      "name": "batchMetadata",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalUpdateCount",
            "type": "i32"
          },
          {
            "name": "numUniqueFixtures",
            "type": "i32"
          },
          {
            "name": "overallBatchStartTs",
            "type": "i64"
          },
          {
            "name": "overallBatchEndTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "binaryExpression",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "add"
          },
          {
            "name": "subtract"
          }
        ]
      }
    },
    {
      "name": "comparison",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "greaterThan"
          },
          {
            "name": "lessThan"
          },
          {
            "name": "equalTo"
          }
        ]
      }
    },
    {
      "name": "fixture",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "startTime",
            "type": "i64"
          },
          {
            "name": "competition",
            "type": "string"
          },
          {
            "name": "competitionId",
            "type": "i32"
          },
          {
            "name": "fixtureGroupId",
            "type": "i32"
          },
          {
            "name": "participant1Id",
            "type": "i32"
          },
          {
            "name": "participant1",
            "type": "string"
          },
          {
            "name": "participant2Id",
            "type": "i32"
          },
          {
            "name": "participant2",
            "type": "string"
          },
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "participant1IsHome",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "fixtureBatchSummary",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "competitionId",
            "type": "i32"
          },
          {
            "name": "competition",
            "type": "string"
          },
          {
            "name": "updateStats",
            "type": {
              "defined": {
                "name": "fixtureUpdateStats"
              }
            }
          },
          {
            "name": "updateSubTreeRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "fixtureUpdateStats",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "updateCount",
            "type": "u32"
          },
          {
            "name": "minTimestamp",
            "type": "i64"
          },
          {
            "name": "maxTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "geometricTarget",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "statIndex",
            "type": "u8"
          },
          {
            "name": "prediction",
            "type": "i32"
          }
        ]
      }
    },
    {
      "name": "marketIntentParams",
      "type": {
        "kind": "struct",
        "fields": []
      }
    },
    {
      "name": "nDimensionalStrategy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "geometricTargets",
            "type": {
              "vec": {
                "defined": {
                  "name": "geometricTarget"
                }
              }
            }
          },
          {
            "name": "distancePredicate",
            "type": {
              "option": {
                "defined": {
                  "name": "traderPredicate"
                }
              }
            }
          },
          {
            "name": "discretePredicates",
            "type": {
              "vec": {
                "defined": {
                  "name": "statPredicate"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "odds",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "messageId",
            "type": "string"
          },
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "bookmaker",
            "type": "string"
          },
          {
            "name": "bookmakerId",
            "type": "i32"
          },
          {
            "name": "superOddsType",
            "type": "string"
          },
          {
            "name": "gameState",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "inRunning",
            "type": "bool"
          },
          {
            "name": "marketParameters",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "marketPeriod",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "priceNames",
            "type": {
              "vec": "string"
            }
          },
          {
            "name": "prices",
            "type": {
              "vec": "i32"
            }
          }
        ]
      }
    },
    {
      "name": "oddsBatchSummary",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "updateStats",
            "type": {
              "defined": {
                "name": "oddsUpdateStats"
              }
            }
          },
          {
            "name": "oddsSubTreeRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "oddsUpdateStats",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "updateCount",
            "type": "u32"
          },
          {
            "name": "minTimestamp",
            "type": "i64"
          },
          {
            "name": "maxTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pricingMatrix",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "rows",
            "type": {
              "vec": {
                "defined": {
                  "name": "serviceRow"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "proofNode",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "isRightSibling",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "scoreStat",
      "docs": [
        "The on-chain representation of a single, provable key-value statistic.",
        "This is the leaf of the inner-most Merkle tree."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": "u32"
          },
          {
            "name": "value",
            "type": "i32"
          },
          {
            "name": "period",
            "type": "i32"
          }
        ]
      }
    },
    {
      "name": "scoresBatchSummary",
      "docs": [
        "The summary for a single fixture's scores events within a 5-minute batch.",
        "This contains the root of the sub-tree of all events for that fixture."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fixtureId",
            "type": "i64"
          },
          {
            "name": "updateStats",
            "type": {
              "defined": {
                "name": "scoresUpdateStats"
              }
            }
          },
          {
            "name": "eventsSubTreeRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "scoresUpdateStats",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "updateCount",
            "type": "i32"
          },
          {
            "name": "minTimestamp",
            "type": "i64"
          },
          {
            "name": "maxTimestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "serviceRow",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rowId",
            "type": "u16"
          },
          {
            "name": "pricePerWeekToken",
            "type": "u64"
          },
          {
            "name": "samplingIntervalSec",
            "type": "u32"
          },
          {
            "name": "leagueBundleId",
            "type": "i16"
          },
          {
            "name": "marketBundleId",
            "type": "i16"
          }
        ]
      }
    },
    {
      "name": "statLeaf",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stat",
            "type": {
              "defined": {
                "name": "scoreStat"
              }
            }
          },
          {
            "name": "statProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "statPredicate",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "single",
            "fields": [
              {
                "name": "index",
                "type": "u8"
              },
              {
                "name": "predicate",
                "type": {
                  "defined": {
                    "name": "traderPredicate"
                  }
                }
              }
            ]
          },
          {
            "name": "binary",
            "fields": [
              {
                "name": "indexA",
                "type": "u8"
              },
              {
                "name": "indexB",
                "type": "u8"
              },
              {
                "name": "op",
                "type": {
                  "defined": {
                    "name": "binaryExpression"
                  }
                }
              },
              {
                "name": "predicate",
                "type": {
                  "defined": {
                    "name": "traderPredicate"
                  }
                }
              }
            ]
          }
        ]
      }
    },
    {
      "name": "statTerm",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "statToProve",
            "type": {
              "defined": {
                "name": "scoreStat"
              }
            }
          },
          {
            "name": "eventStatRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "statProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "statValidationInput",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "fixtureSummary",
            "type": {
              "defined": {
                "name": "scoresBatchSummary"
              }
            }
          },
          {
            "name": "fixtureProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          },
          {
            "name": "mainTreeProof",
            "type": {
              "vec": {
                "defined": {
                  "name": "proofNode"
                }
              }
            }
          },
          {
            "name": "eventStatRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stats",
            "type": {
              "vec": {
                "defined": {
                  "name": "statLeaf"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "traderPredicate",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "threshold",
            "type": "i32"
          },
          {
            "name": "comparison",
            "type": {
              "defined": {
                "name": "comparison"
              }
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "backendAdminPubkey",
      "type": "pubkey",
      "value": "54Wot8oX53yKTtfoJwMc8RHrsqL1p6WC71devAoB1GGT"
    },
    {
      "name": "lamportsPerSol",
      "type": "f64",
      "value": "1000000000.0"
    },
    {
      "name": "minDepositTokens",
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "minUserBalance",
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "stakeAmount",
      "type": "u64",
      "value": "250000000"
    },
    {
      "name": "subscriptionDuration",
      "type": "i64",
      "value": "604800"
    },
    {
      "name": "subscriptionPriceToken",
      "type": "u64",
      "value": "25000000"
    },
    {
      "name": "tokenDecimals",
      "type": "u32",
      "value": "6"
    },
    {
      "name": "tokenPriceInSol",
      "type": "f64",
      "value": "0.01"
    },
    {
      "name": "tokenPriceInUsdt",
      "type": "u128",
      "value": "1000"
    },
    {
      "name": "txlineMint",
      "type": "pubkey",
      "value": "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"
    },
    {
      "name": "usdtDecimalsFactor",
      "type": "u128",
      "value": "1000000"
    },
    {
      "name": "usdtMint",
      "type": "pubkey",
      "value": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
    }
  ]
};
