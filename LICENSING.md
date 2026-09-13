# Knomo licensing

Copyright (c) 2026 BanyanSo

## Current license

The Knomo 1.10.0 licensing change licenses Knomo's original code, styles,
documentation, and original assets under the GNU General Public License,
version 3 only (GPL-3.0-only), with the Knomo Obsidian Host Additional
Permission. This applies to the revision introducing these licensing files
and subsequent contributions under this policy. Historical grants and
separately licensed third-party material are described below.

Read these files together:

- [LICENSE](LICENSE): the unmodified GNU GPL version 3 text.
- [OBSIDIAN-EXCEPTION.txt](OBSIDIAN-EXCEPTION.txt): the narrow additional
  permission under GPLv3 section 7 for use with the Obsidian host.
- [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt): third-party licenses and
  copyright notices, which remain applicable to their respective material.

The actual license is **GPL-3.0-only with the Knomo Obsidian Host Additional
Permission**, not bare GPL-3.0-only and not an MIT/GPL dual license for new
Knomo contributions. Package metadata uses `SEE LICENSE IN LICENSING.md`
because the custom host permission must be read alongside the GPL.
The GPL's standard "How to Apply" example is not Knomo's license grant:
Knomo does not grant an "or any later version" option.

You may use, modify, and commercially distribute covered Knomo works in
accordance with these terms. Distributing covered modified works requires
compliance with the GPL, including applicable source, license, copyright,
change-notice, and warranty-notice obligations. Extracting a covered code
fragment, style, component, or utility does not by itself remove those
obligations. There is no warranty, to the extent permitted by law, as stated
in the GPL. This summary does not replace the license terms.

The host permission does not authorize copying or distributing Obsidian,
waive its terms, or exempt arbitrary proprietary modules. It does not remove
the source obligations for Knomo or its bundled third-party code.

## Historical MIT grants

Earlier Knomo material was made available under the MIT License. Those
grants are not revoked. Recipients may continue to use that material under
its original MIT terms, including maintaining MIT-based forks. Applying this
license to a current revision cannot remove an MIT permission already
received for identical material.

The maintainer confirmed the public `main` MIT baseline as
`07439a8df19053d73914ed352edca64f63571b7c` during preparation of 1.10.0.
This identifies a confirmed baseline, not an assertion that no other MIT
copies or revisions were ever distributed. Existing Git history, tags, and
releases are not rewritten by this migration.

[LICENSES/Knomo-historical-MIT.txt](LICENSES/Knomo-historical-MIT.txt)
preserves the original Knomo MIT notice in full. It applies to material
previously provided under that license; its presence does not grant MIT
permission for new contributions under the current policy. Preserve it when
distributing the historical material included in this work.

## Third-party material, brand, and user content

Third-party material retains its own license and attribution requirements.
An MIT dependency is not converted into exclusively GPL-licensed upstream
code by being bundled with Knomo. Update the third-party inventory when the
actual distribution changes; a dependency's package.json category does not
determine whether its code is distributed.

The maintainer has confirmed authorship and licensing authority for Knomo's
own code, original embedded SVGs, and logo, and has identified no uncredited
copied code or assets. Icons requested through Obsidian's icon API are
host-provided resources, not a claim of Knomo authorship. Screenshots may
depict host interfaces and third-party marks; this license does not grant
rights in independently owned content merely because it is depicted.

[BRANDING.md](BRANDING.md) addresses names, marks, and official identity
separately from copyright licensing. [CONTRIBUTING.md](CONTRIBUTING.md)
describes the license for new contributions. Ordinary user notes, Daily
Notes, Monthly projections, and other user content do not become GPL-covered
merely by being created or processed with Knomo.

## Source and distribution: release work still required

The [source repository](https://github.com/BanyanSo/knomo) contains the
development source. A moving repository link, a lockfile, or a GitHub
automatic source archive alone is not a declaration that the complete
Corresponding Source for a particular binary has been provided.

This change updates licensing files and metadata only. It does not update
the build or release workflow, retrofit existing main.js, or certify an
existing binary. The current workflow uploads only main.js, manifest.json,
and styles.css. GPL release delivery therefore remains pending.

Before distributing the 1.10.0 GPL release, the release maintainer must:

1. Match the `1.10.0` tag, manifest, package metadata, lockfile, and exact
   source commit, and build the assets from those recorded inputs.
2. Supply LICENSE, this licensing notice, OBSIDIAN-EXCEPTION.txt, applicable
   historical MIT notices, and complete third-party notices with the work.
   Verify delivery for the three-file installation path as well as any ZIP;
   do not assume the installer downloads extra legal files.
3. Provide complete Corresponding Source, including preferred modification
   forms and necessary build/install scripts and dependency source material,
   with clear version-specific directions next to the binary download and
   equivalent access at no further charge under GPLv3 section 6(d).
   Verify generated dependency distributions against their source and retain
   any necessary patches or generation inputs. Host code excluded by the
   additional permission is not a reason to omit bundled library source.
4. Verify the release from a clean checkout and the delivered source package;
   record build tool versions, dependency provenance, and asset checksums.
   Run the current project verify gate and additional release checks without
   duplicating checks already included in that gate.
5. Check the actual uploaded assets, source availability, notices, and
   provenance at release time. Maintain source availability as required by
   the chosen GPL distribution method.

The host permission is a copyright permission from the covered Knomo
contributors, not an endorsement or authorization from Obsidian. These files
do not certify compliance with Obsidian's own terms or every distribution
channel's requirements.

## 中文摘要

Knomo 1.10.0 的本次许可变更采用 **GPL-3.0-only，加 Knomo Obsidian 宿主附加许可**。
根 LICENSE 保持 GPLv3 标准全文；仅适用版本 3，不包含“或任何后续版本”的选择。
宿主附加许可仅处理作为插件与独立取得的 Obsidian 结合，不免除 Knomo 及其受覆盖
修改的 GPL 义务，不授权复制或分发 Obsidian，也不为任意闭源模块提供豁免。

历史 MIT 授权继续有效，原 MIT 全文独立保留；新贡献不会因此同时获得 MIT 授权。
第三方代码和资源保留各自许可。代码版权许可、品牌与官方身份分别处理，用户笔记
不会仅因使用 Knomo 而变为 GPL 内容。分发修改版时，应履行适用的源码、许可、
版权、修改说明及无担保声明义务。

本次仅更新许可文件及元数据，尚未实现发行物自动携带完整声明或对应源码交付。
正式发布前仍需完成上面的版本、源码、干净构建、发行物和下载可用性验收。
此摘要供阅读便利；具体授权以 LICENSE 和 OBSIDIAN-EXCEPTION.txt 的英文条款为准。
