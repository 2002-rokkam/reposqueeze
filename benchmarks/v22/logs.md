compactLog on 76 real dev CI logs from 32 repositories, 5435153 input tokens (o200k_base)

| budget | variant | output tokens | reduction vs raw | strong lines kept (macro mean per log) | strong lines kept (pooled) | root-cause lines kept (macro) | root-cause lines kept (pooled) | logs with all root-cause lines kept | logs with no root-cause line kept |
|---|---|---|---|---|---|---|---|---|---|
| 1000 | baseline | 75676 | 98.6% | 6.0% | 2.3% | 5.0% | 1.7% | 3/74 | 70/74 |
| 1000 | new | 56699 | 99.0% | 92.0% | 44.3% | 95.8% | 47.3% | 70/74 | 0/74 |
| 2000 | baseline | 146427 | 97.3% | 28.0% | 9.1% | 26.4% | 8.5% | 17/74 | 53/74 |
| 2000 | new | 88326 | 98.4% | 93.0% | 52.2% | 96.3% | 53.3% | 70/74 | 0/74 |

2 logs are already within 2000 tokens; 1 logs contain no strong failure line.

[
 {
  "file": "dev/apache_kafka__41164778591__124429875944__failed.log",
  "ecosystem": "java",
  "repo": "apache/kafka",
  "inTokens": 12689,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 755,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 984,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/apache_kafka__41185447905__124491354879__failed.log",
  "ecosystem": "java",
  "repo": "apache/kafka",
  "inTokens": 103093,
  "strong": 0,
  "root": 0,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 978,
     "strongKept": 0,
     "rootKept": 0
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1828,
     "strongKept": 0,
     "rootKept": 0
    }
   }
  }
 },
 {
  "file": "dev/apache_kafka__41185447905__124492192003__full.log",
  "ecosystem": "java",
  "repo": "apache/kafka",
  "inTokens": 45736,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 668,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1663,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 835,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/apache_kafka__41185867470__124492554265__failed.log",
  "ecosystem": "java",
  "repo": "apache/kafka",
  "inTokens": 38343,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 998,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1236,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/astral-sh_ruff__41159997255__124415220465__failed.log",
  "ecosystem": "rust",
  "repo": "astral-sh/ruff",
  "inTokens": 104897,
  "strong": 3,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 556,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 772,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/astral-sh_ruff__41159997366__124415221514__full.log",
  "ecosystem": "rust",
  "repo": "astral-sh/ruff",
  "inTokens": 44595,
  "strong": 3,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 539,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 736,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/composer_composer__40926059786__123631749506__failed.log",
  "ecosystem": "php",
  "repo": "composer/composer",
  "inTokens": 31162,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 785,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 977,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/composer_composer__41033449767__123988443733__failed.log",
  "ecosystem": "php",
  "repo": "composer/composer",
  "inTokens": 21991,
  "strong": 3,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 660,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 834,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/discourse_discourse__38931221318__117075394306__failed.log",
  "ecosystem": "ruby",
  "repo": "discourse/discourse",
  "inTokens": 29600,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 787,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 953,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/discourse_discourse__38947472010__117130132870__failed.log",
  "ecosystem": "ruby",
  "repo": "discourse/discourse",
  "inTokens": 89885,
  "strong": 8,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 993,
     "strongKept": 6,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1179,
     "strongKept": 6,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/django_django__40878915890__123464869820__failed.log",
  "ecosystem": "pytest",
  "repo": "django/django",
  "inTokens": 9683,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 648,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1557,
     "strongKept": 2,
     "rootKept": 1
    },
    "new": {
     "tokens": 1864,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/django_django__41168428899__124440929560__full.log",
  "ecosystem": "pytest",
  "repo": "django/django",
  "inTokens": 20235,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 432,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1238,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 600,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/django_django__41173373352__124455815479__failed.log",
  "ecosystem": "pytest",
  "repo": "django/django",
  "inTokens": 9359,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 479,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1307,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 1794,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/dotnet_aspire__41175102009__124462147922__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/aspire",
  "inTokens": 46979,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 909,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1076,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/dotnet_aspire__41175594640__124467041214__full.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/aspire",
  "inTokens": 128084,
  "strong": 12,
  "root": 10,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 986,
     "strongKept": 11,
     "rootKept": 10
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1991,
     "strongKept": 12,
     "rootKept": 10
    }
   }
  }
 },
 {
  "file": "dev/dotnet_aspire__41175594640__124479702197__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/aspire",
  "inTokens": 172500,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 473,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 726,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/dotnet_aspire__41189067487__124501941155__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/aspire",
  "inTokens": 4212,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 794,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 1596,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/dotnet_efcore__41169489243__124444151615__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/efcore",
  "inTokens": 269078,
  "strong": 65,
  "root": 65,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 989,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1986,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/dotnet_maui__41171184415__124449357922__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/maui",
  "inTokens": 40439,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 993,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1196,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/dotnet_maui__41172141288__124452182756__full.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/maui",
  "inTokens": 264785,
  "strong": 28,
  "root": 23,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 990,
     "strongKept": 6,
     "rootKept": 5
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 1767,
     "strongKept": 13,
     "rootKept": 11
    }
   }
  }
 },
 {
  "file": "dev/dotnet_maui__41178356806__124470743553__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/maui",
  "inTokens": 276873,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 999,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1993,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/dotnet_maui__41178356806__124471323711__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/maui",
  "inTokens": 24478,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 721,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 911,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/dotnet_runtime__41145059532__124368115144__failed.log",
  "ecosystem": "dotnet",
  "repo": "dotnet/runtime",
  "inTokens": 1440,
  "strong": 3,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 685,
     "strongKept": 3,
     "rootKept": 2
    },
    "new": {
     "tokens": 403,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 1361,
     "strongKept": 3,
     "rootKept": 2
    },
    "new": {
     "tokens": 403,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/etcd-io_etcd__40795075487__123189457581__full.log",
  "ecosystem": "go",
  "repo": "etcd-io/etcd",
  "inTokens": 11647,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 512,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1751,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 1806,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/grafana_grafana__41188711294__124501322268__full.log",
  "ecosystem": "go",
  "repo": "grafana/grafana",
  "inTokens": 63150,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 926,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1042,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/grafana_grafana__41188711370__124500850835__failed.log",
  "ecosystem": "go",
  "repo": "grafana/grafana",
  "inTokens": 4854,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 552,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1008,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/grafana_grafana__41188711440__124500850350__failed.log",
  "ecosystem": "go",
  "repo": "grafana/grafana",
  "inTokens": 3353,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 927,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 927,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/hashicorp_terraform__40703673918__122869925349__full.log",
  "ecosystem": "go",
  "repo": "hashicorp/terraform",
  "inTokens": 31117,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 982,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1990,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/hashicorp_terraform__40718616779__122926288900__failed.log",
  "ecosystem": "go",
  "repo": "hashicorp/terraform",
  "inTokens": 25028,
  "strong": 5,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 976,
     "strongKept": 4,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1867,
     "strongKept": 4,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/hashicorp_terraform__40952349990__123723460021__failed.log",
  "ecosystem": "go",
  "repo": "hashicorp/terraform",
  "inTokens": 10410,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 458,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1804,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 681,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/jestjs_jest__40415519415__121897048844__failed.log",
  "ecosystem": "js",
  "repo": "jestjs/jest",
  "inTokens": 31599,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 560,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 691,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/laravel_framework__40638058022__122649518689__failed.log",
  "ecosystem": "php",
  "repo": "laravel/framework",
  "inTokens": 30870,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 458,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 648,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/laravel_framework__40743722728__123011841912__failed.log",
  "ecosystem": "php",
  "repo": "laravel/framework",
  "inTokens": 40165,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 762,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 881,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/laravel_framework__40743722728__123011842028__full.log",
  "ecosystem": "php",
  "repo": "laravel/framework",
  "inTokens": 45193,
  "strong": 3,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 721,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 890,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/laravel_framework__41016427702__123933698611__failed.log",
  "ecosystem": "php",
  "repo": "laravel/framework",
  "inTokens": 46113,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 467,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 682,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/llvm_llvm-project__41185281373__124490858954__failed.log",
  "ecosystem": "cpp",
  "repo": "llvm/llvm-project",
  "inTokens": 2176,
  "strong": 4,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 631,
     "strongKept": 4,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 1471,
     "strongKept": 4,
     "rootKept": 3
    },
    "new": {
     "tokens": 631,
     "strongKept": 4,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/mastodon_mastodon__40740088247__122999015498__failed.log",
  "ecosystem": "ruby",
  "repo": "mastodon/mastodon",
  "inTokens": 52155,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 688,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 882,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/mastodon_mastodon__40906039543__123560939424__failed.log",
  "ecosystem": "ruby",
  "repo": "mastodon/mastodon",
  "inTokens": 47012,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 549,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 703,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/mastodon_mastodon__41071273730__124115746970__failed.log",
  "ecosystem": "ruby",
  "repo": "mastodon/mastodon",
  "inTokens": 13412,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 409,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 635,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/opencv_opencv__41163170054__124424977018__failed.log",
  "ecosystem": "cpp",
  "repo": "opencv/opencv",
  "inTokens": 236239,
  "strong": 3,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 984,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1880,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/pallets_flask__34727211038__103643345311__failed.log",
  "ecosystem": "pytest",
  "repo": "pallets/flask",
  "inTokens": 14407,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 418,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 613,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/pallets_flask__37632626982__112830562987__full.log",
  "ecosystem": "pytest",
  "repo": "pallets/flask",
  "inTokens": 12674,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 735,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 923,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/pallets_flask__37633292268__112832844965__failed.log",
  "ecosystem": "pytest",
  "repo": "pallets/flask",
  "inTokens": 12012,
  "strong": 3,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 668,
     "strongKept": 3,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 3,
     "rootKept": 1
    },
    "new": {
     "tokens": 914,
     "strongKept": 3,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/pandas-dev_pandas__41155718438__124401955973__failed.log",
  "ecosystem": "pytest",
  "repo": "pandas-dev/pandas",
  "inTokens": 89721,
  "strong": 3,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 992,
     "strongKept": 3,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 1571,
     "strongKept": 3,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/prometheus_prometheus__41090840633__124183990406__failed.log",
  "ecosystem": "go",
  "repo": "prometheus/prometheus",
  "inTokens": 37465,
  "strong": 11,
  "root": 10,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1000,
     "strongKept": 10,
     "rootKept": 10
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1958,
     "strongKept": 10,
     "rootKept": 10
    }
   }
  }
 },
 {
  "file": "dev/prometheus_prometheus__41141340486__124356060836__failed.log",
  "ecosystem": "go",
  "repo": "prometheus/prometheus",
  "inTokens": 23877,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 648,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 848,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/pytest-dev_pytest__41162652148__124423492547__failed.log",
  "ecosystem": "pytest",
  "repo": "pytest-dev/pytest",
  "inTokens": 31603,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 490,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 697,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/pytest-dev_pytest__41187918874__124501001562__failed.log",
  "ecosystem": "pytest",
  "repo": "pytest-dev/pytest",
  "inTokens": 1349,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 362,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1291,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 362,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/quarkusio_quarkus__41154215733__124397332231__failed.log",
  "ecosystem": "java",
  "repo": "quarkusio/quarkus",
  "inTokens": 107783,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 664,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 840,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/rails_rails__39922854490__120312005130__failed.log",
  "ecosystem": "ruby",
  "repo": "rails/rails",
  "inTokens": 63337,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 991,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1585,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/rails_rails__39922854491__120312005029__full.log",
  "ecosystem": "ruby",
  "repo": "rails/rails",
  "inTokens": 64851,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 526,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 689,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/rails_rails__40669083636__122750977849__failed.log",
  "ecosystem": "ruby",
  "repo": "rails/rails",
  "inTokens": 140225,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 990,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1981,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/rubocop_rubocop__41065716230__124097230363__failed.log",
  "ecosystem": "ruby",
  "repo": "rubocop/rubocop",
  "inTokens": 27185,
  "strong": 3,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 898,
     "strongKept": 3,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 1592,
     "strongKept": 3,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/rubocop_rubocop__41072141183__124118718994__full.log",
  "ecosystem": "ruby",
  "repo": "rubocop/rubocop",
  "inTokens": 30550,
  "strong": 3,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 802,
     "strongKept": 3,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 1551,
     "strongKept": 3,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/rubocop_rubocop__41079684523__124145163993__failed.log",
  "ecosystem": "ruby",
  "repo": "rubocop/rubocop",
  "inTokens": 31010,
  "strong": 3,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 802,
     "strongKept": 3,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 1551,
     "strongKept": 3,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/rust-lang_cargo__40009149011__120604702638__full.log",
  "ecosystem": "rust",
  "repo": "rust-lang/cargo",
  "inTokens": 16794,
  "strong": 3,
  "root": 0,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 968,
     "strongKept": 3,
     "rootKept": 0
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 3,
     "rootKept": 0
    },
    "new": {
     "tokens": 1384,
     "strongKept": 3,
     "rootKept": 0
    }
   }
  }
 },
 {
  "file": "dev/rust-lang_cargo__40990214045__123850517976__failed.log",
  "ecosystem": "rust",
  "repo": "rust-lang/cargo",
  "inTokens": 51410,
  "strong": 3,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 586,
     "strongKept": 3,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 731,
     "strongKept": 3,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/rust-lang_cargo__40990214045__123851975786__failed.log",
  "ecosystem": "rust",
  "repo": "rust-lang/cargo",
  "inTokens": 8954,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 565,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 1136,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 565,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/rust-lang_cargo__41059517420__124075879856__failed.log",
  "ecosystem": "rust",
  "repo": "rust-lang/cargo",
  "inTokens": 27143,
  "strong": 7,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 719,
     "strongKept": 6,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 973,
     "strongKept": 6,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/spring-projects_spring-boot__40491759303__122147168183__failed.log",
  "ecosystem": "java",
  "repo": "spring-projects/spring-boot",
  "inTokens": 31386,
  "strong": 1,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 643,
     "strongKept": 1,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 1,
     "rootKept": 1
    },
    "new": {
     "tokens": 891,
     "strongKept": 1,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/spring-projects_spring-boot__40845612088__123352237103__failed.log",
  "ecosystem": "java",
  "repo": "spring-projects/spring-boot",
  "inTokens": 721768,
  "strong": 5,
  "root": 4,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 995,
     "strongKept": 5,
     "rootKept": 4
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1467,
     "strongKept": 5,
     "rootKept": 4
    }
   }
  }
 },
 {
  "file": "dev/spring-projects_spring-boot__41086676542__124169523573__full.log",
  "ecosystem": "java",
  "repo": "spring-projects/spring-boot",
  "inTokens": 204111,
  "strong": 6,
  "root": 6,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 957,
     "strongKept": 6,
     "rootKept": 6
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1907,
     "strongKept": 6,
     "rootKept": 6
    }
   }
  }
 },
 {
  "file": "dev/spring-projects_spring-boot__41091753817__124187136876__failed.log",
  "ecosystem": "java",
  "repo": "spring-projects/spring-boot",
  "inTokens": 285553,
  "strong": 8,
  "root": 7,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 898,
     "strongKept": 8,
     "rootKept": 7
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1992,
     "strongKept": 8,
     "rootKept": 7
    }
   }
  }
 },
 {
  "file": "dev/spring-projects_spring-framework__40181497513__121133338297__failed.log",
  "ecosystem": "java",
  "repo": "spring-projects/spring-framework",
  "inTokens": 53223,
  "strong": 5,
  "root": 4,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 986,
     "strongKept": 5,
     "rootKept": 4
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1372,
     "strongKept": 5,
     "rootKept": 4
    }
   }
  }
 },
 {
  "file": "dev/spring-projects_spring-framework__41069583957__124109846004__failed.log",
  "ecosystem": "java",
  "repo": "spring-projects/spring-framework",
  "inTokens": 49218,
  "strong": 3,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 922,
     "strongKept": 3,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1118,
     "strongKept": 3,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/sveltejs_svelte__40983940180__123830363616__full.log",
  "ecosystem": "js",
  "repo": "sveltejs/svelte",
  "inTokens": 19285,
  "strong": 3,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 898,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1000,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/symfony_symfony__41182836476__124483601166__failed.log",
  "ecosystem": "php",
  "repo": "symfony/symfony",
  "inTokens": 24425,
  "strong": 19,
  "root": 4,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 1,
     "rootKept": 0
    },
    "new": {
     "tokens": 629,
     "strongKept": 3,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 3,
     "rootKept": 0
    },
    "new": {
     "tokens": 818,
     "strongKept": 3,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/symfony_symfony__41188818870__124501176418__failed.log",
  "ecosystem": "php",
  "repo": "symfony/symfony",
  "inTokens": 208969,
  "strong": 44,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 979,
     "strongKept": 5,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1996,
     "strongKept": 19,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/tokio-rs_tokio__41117984591__124277074227__failed.log",
  "ecosystem": "rust",
  "repo": "tokio-rs/tokio",
  "inTokens": 28343,
  "strong": 3,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 491,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 712,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/tokio-rs_tokio__41131135454__124322776988__failed.log",
  "ecosystem": "rust",
  "repo": "tokio-rs/tokio",
  "inTokens": 48777,
  "strong": 5,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 578,
     "strongKept": 4,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 1999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 728,
     "strongKept": 4,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/tokio-rs_tokio__41131135454__124322777076__full.log",
  "ecosystem": "rust",
  "repo": "tokio-rs/tokio",
  "inTokens": 22787,
  "strong": 2,
  "root": 1,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 578,
     "strongKept": 2,
     "rootKept": 1
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 755,
     "strongKept": 2,
     "rootKept": 1
    }
   }
  }
 },
 {
  "file": "dev/vitest-dev_vitest__41025666614__123964184873__failed.log",
  "ecosystem": "js",
  "repo": "vitest-dev/vitest",
  "inTokens": 35917,
  "strong": 5,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 999,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 992,
     "strongKept": 5,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1200,
     "strongKept": 5,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/vitest-dev_vitest__41027163201__123967985773__full.log",
  "ecosystem": "js",
  "repo": "vitest-dev/vitest",
  "inTokens": 46059,
  "strong": 4,
  "root": 3,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 977,
     "strongKept": 4,
     "rootKept": 3
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1351,
     "strongKept": 4,
     "rootKept": 3
    }
   }
  }
 },
 {
  "file": "dev/vuejs_core__41118768362__124279760679__full.log",
  "ecosystem": "js",
  "repo": "vuejs/core",
  "inTokens": 12950,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 636,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 1933,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 848,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 },
 {
  "file": "dev/vuejs_core__41118768362__124279760986__failed.log",
  "ecosystem": "js",
  "repo": "vuejs/core",
  "inTokens": 352146,
  "strong": 137,
  "root": 118,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 984,
     "strongKept": 16,
     "rootKept": 16
    }
   },
   "2000": {
    "base": {
     "tokens": 2000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 1947,
     "strongKept": 32,
     "rootKept": 31
    }
   }
  }
 },
 {
  "file": "dev/vuejs_core__41118778383__124279795290__failed.log",
  "ecosystem": "js",
  "repo": "vuejs/core",
  "inTokens": 13257,
  "strong": 2,
  "root": 2,
  "budgets": {
   "1000": {
    "base": {
     "tokens": 1000,
     "strongKept": 0,
     "rootKept": 0
    },
    "new": {
     "tokens": 635,
     "strongKept": 2,
     "rootKept": 2
    }
   },
   "2000": {
    "base": {
     "tokens": 1931,
     "strongKept": 2,
     "rootKept": 2
    },
    "new": {
     "tokens": 815,
     "strongKept": 2,
     "rootKept": 2
    }
   }
  }
 }
]
