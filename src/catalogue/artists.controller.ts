import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogueAccess } from './catalogue.access';

@ApiTags('catalogue')
@ApiBearerAuth()
@Controller('me/artists')
export class ArtistsController {
  constructor(
    private readonly access: CatalogueAccess,
    private readonly prisma: PrismaService,
  ) {}

  @ApiOperation({
    summary: 'Artists I can release for',
    description:
      'Whoever the caller may create a release under: their own artist, a label’s whole roster, or the artists a MANAGER seat covers. A VIEWER seat is excluded — they can read a catalogue without adding to it.',
  })
  @Get()
  async writable(@CurrentUser('sub') userId: string) {
    const scope = await this.access.scopeFor(userId);

    // Asked as one question rather than three: the app used to decide whether
    // to offer an artist picker by checking `user.label`, which is the wrong
    // question — it left a MANAGER seat holder with no way to name the artist
    // they were invited to manage, and so unable to create anything at all.
    const artists = await this.prisma.artist.findMany({
      where: { id: { in: scope.writableArtistIds } },
      select: { id: true, stageName: true },
      orderBy: { stageName: 'asc' },
    });

    return artists;
  }
}
